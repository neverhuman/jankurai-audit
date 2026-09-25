import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '../ops/ci/check-token-rotation.sh');

function remaining(expires) {
  return Math.ceil((Date.parse(`${expires}T00:00:00Z`) - Date.now()) / 86400000);
}

function dateWithRemaining(wanted) {
  const today = new Date();
  for (let offset = 0; offset < 60; offset += 1) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset));
    const expires = day.toISOString().slice(0, 10);
    if (remaining(expires) === wanted) return expires;
  }
  throw new Error(`no YYYY-MM-DD with ${wanted} days remaining`);
}

function run(expires) {
  const env = { ...process.env };
  if (expires === undefined) delete env.AUTOMATION_TOKEN_EXPIRES;
  else env.AUTOMATION_TOKEN_EXPIRES = expires;
  return spawnSync('bash', [script], { env, encoding: 'utf8' });
}

test('missing or non-canonical expiry fails closed', () => {
  for (const expires of [undefined, '', '2026-10-8', '2026-02-31', 'tomorrow', '2099-01-01T00:00:00Z']) {
    const result = run(expires);
    assert.notEqual(result.status, 0, String(expires));
    assert.match(result.stderr, /YYYY-MM-DD/);
  }
});

test('fourteen days fails and fifteen days passes without moving the threshold', () => {
  const due = run(dateWithRemaining(14));
  assert.notEqual(due.status, 0);
  assert.match(due.stderr, /14 days remain/);
  const ok = run(dateWithRemaining(15));
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /15 days remain/);
});
