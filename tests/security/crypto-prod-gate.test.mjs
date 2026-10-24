// node --test tests/security/crypto-prod-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGate } from './crypto-prod-gate.mjs';

function repo(files) {
  const r = mkdtempSync(join(tmpdir(), 'gate-'));
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(r, p, '..'), { recursive: true }); writeFileSync(join(r, p), c); }
  return r;
}
const clean = {
  'packages/crypto/src/a.ts': "export const k = crypto.getRandomValues(new Uint8Array(32));\n",
  'frontend/src/api.ts': "export const u = process.env.NEXT_PUBLIC_API_URL;\n",
  'frontend/src/fx.ts': "export const on = process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_CHAT_FIXTURES === '1';\n",
  '.env.example': 'SESSION_SECRET=CHANGE_ME\nDATABASE_URL=postgres://u:p@localhost/db\nPROXY_SHARED_SECRET=\n',
};

test('clean repo passes', () => assert.deepEqual(runGate(repo(clean)), []));

test('each violation is reported', () => {
  const cases = {
    'packages/crypto/src/a.ts': 'const n = Math.random();',
    'packages/crypto/src/b.ts': "import { FakeBackend } from '../test/fake-backend.js';",
    'packages/crypto/src/c.ts': 'export const skipVerification = true;',
    'packages/crypto/src/d.ts': 'const k = process.env.KEY;',
    'frontend/src/e.ts': 'process.env.NEXT_PUBLIC_SIGNING_KEY',
    'frontend/src/f.ts': "const on = process.env.NEXT_PUBLIC_CHAT_FIXTURES === '1';",
    '.env': 'SESSION_SECRET=abc',
    'keys/id.pem': '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
    'frontend/.env.example': 'PROXY_SHARED_SECRET=Zm9vYmFyYmF6cXV4cXV1eA==',
  };
  for (const [p, c] of Object.entries(cases)) {
    const f = runGate(repo({ ...clean, [p]: c }));
    assert.ok(f.length > 0, `expected a finding for ${p}`);
  }
});

test('test/e2e files may reference fixtures', () => {
  assert.deepEqual(runGate(repo({ ...clean, 'frontend/e2e/x.spec.ts': "process.env.NEXT_PUBLIC_CHAT_FIXTURES='1'" })), []);
});
