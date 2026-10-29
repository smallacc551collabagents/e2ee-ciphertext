#!/usr/bin/env node
// E2EE-62 crypto production gate (source + repo level). Complements prod-bundle-scan.mjs (built bundle).
// Usage: node tests/security/crypto-prod-gate.mjs [repoRoot]   — exits 1 with findings.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLIC_ENV_ALLOWLIST = new Set(['NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_WS_URL', 'NEXT_PUBLIC_CHAT_FIXTURES', 'NEXT_PUBLIC_TEST_ACCOUNTS']);
const SECRET_NAME = /SECRET|PASSWORD|PRIVATE|TOKEN|DATABASE_URL|(^|_)KEY($|_)/;
const PLACEHOLDER = /^$|CHANGE|change[-_ ]?me|placeholder|example|localhost|127\.0\.0\.1|<.*>/i;

function walk(dir, re, out = []) {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f === '.next' || f === 'dist') continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, re, out); else if (re.test(p)) out.push(p);
  }
  return out;
}

const isTestFile = (p) => /[\\/](e2e|tests?|__tests__)[\\/]|\.(test|spec)\.[jt]sx?$/.test(p);

function trackedFiles(root) {
  try { return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean); }
  catch { return walk(root, /./).map((p) => relative(root, p)); }
}

export function runGate(root) {
  const findings = [];
  const rel = (p) => relative(root, p);

  // 1. Production crypto source: real crypto only, no test doubles, no bypass switches, no weak RNG.
  for (const f of walk(join(root, 'packages/crypto/src'), /\.ts$/)) {
    const s = readFileSync(f, 'utf8');
    if (/Math\.random\s*\(/.test(s)) findings.push(`weak RNG (Math.random) in ${rel(f)}`);
    if (/from\s+['"][^'"]*\/test\//.test(s)) findings.push(`production code imports test code: ${rel(f)}`);
    if (/\b(FakeBackend|InMemoryRelay|memGate|mock[A-Z]\w*|createMock\w*)\b/.test(s)) findings.push(`test double referenced in ${rel(f)}`);
    if (/\b(skipVerif\w*|disableE2EE|insecure\w*|bypass\w*|DISABLE_CRYPTO|E2EE_DISABLED)\b/i.test(s)) findings.push(`crypto bypass switch in ${rel(f)}`);
    if (/process\.env/.test(s)) findings.push(`crypto package reads env (keys must never come from env): ${rel(f)}`);
  }

  // 2. Frontend: only allow-listed public env names; nothing secret-looking can be NEXT_PUBLIC_.
  for (const f of walk(join(root, 'frontend'), /\.(ts|tsx|js|mjs|cjs)$/).filter((p) => !isTestFile(p))) {
    for (const [name] of readFileSync(f, 'utf8').matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) {
      if (!PUBLIC_ENV_ALLOWLIST.has(name) || SECRET_NAME.test(name.slice(12))) findings.push(`public env not allow-listed: ${name} in ${rel(f)}`);
    }
  }
  // Fixtures switch must be dead in production builds.
  for (const f of walk(join(root, 'frontend'), /\.(ts|tsx)$/).filter((p) => !isTestFile(p))) {
    const s = readFileSync(f, 'utf8');
    if (s.includes('NEXT_PUBLIC_CHAT_FIXTURES') && !/NODE_ENV\s*!==?\s*['"]production['"]|NODE_ENV\s*===?\s*['"](development|test)['"]/.test(s)) {
      findings.push(`fixtures switch not gated on NODE_ENV in ${rel(f)}`);
    }
  }

  // 3. Repo: no committed env files with values, no private keys, example secrets are placeholders.
  for (const t of trackedFiles(root)) {
    const base = t.split('/').pop();
    if (/^\.env(\..+)?$/.test(base) && !base.endsWith('.example')) findings.push(`env file committed: ${t}`);
    const p = join(root, t);
    if (!existsSync(p) || statSync(p).size > 2_000_000 || /\.(png|jpg|ico|woff2?|wasm|lock|yaml)$/.test(t)) continue;
    const s = readFileSync(p, 'utf8');
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s) && !t.startsWith('tests/security/')) findings.push(`private key material in ${t}`);
    if (base.endsWith('.env.example') || base === '.env.example') {
      for (const line of s.split('\n')) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        const [, k, v] = m;
        if (k.startsWith('NEXT_PUBLIC_') && SECRET_NAME.test(k.slice(12))) findings.push(`secret-looking public env in ${t}: ${k}`);
        if (SECRET_NAME.test(k) && !PLACEHOLDER.test(v.trim())) findings.push(`non-placeholder value for ${k} in ${t}`);
      }
    }
  }
  return findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? process.cwd();
  const f = runGate(root);
  if (f.length) { console.error('Crypto production gate FAILED:\n' + f.join('\n')); process.exit(1); }
  console.log('Crypto production gate OK');
}
