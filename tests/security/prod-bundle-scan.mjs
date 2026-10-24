#!/usr/bin/env node
// E2EE-44 / E2EE-62: fail if the production client bundle contains dev fixtures,
// mock crypto, or secret-looking values. Run after `pnpm --filter frontend build`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'frontend/.next/static';
const FORBIDDEN = [
  ['fixtures adapter', /Ava Testwell|Project Falcon|"fixtures"/],
  ['fixtures switch', /NEXT_PUBLIC_CHAT_FIXTURES/],
  ['mock crypto', /mock[-_ ]?crypto|InMemoryRelay|FakeBackend/i],
  ['private key material', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['server secret name', /DATABASE_URL|SESSION_SECRET|JWT_SECRET/],
];
const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(js|css|html|json)$/.test(p)) files.push(p); } };
try { walk(root); } catch { console.error(`no build output at ${root}; run the frontend build first`); process.exit(2); }
const hits = [];
for (const f of files) { const s = readFileSync(f, 'utf8'); for (const [name, re] of FORBIDDEN) if (re.test(s)) hits.push(`${name}: ${f}`); }
if (hits.length) { console.error('Production bundle scan FAILED:\n' + hits.join('\n')); process.exit(1); }
console.log(`Production bundle scan OK (${files.length} files)`);
