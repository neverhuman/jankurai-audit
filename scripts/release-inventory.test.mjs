import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { verifyInventory } from '../ops/release/verify-release-assets.mjs';

const KEY = 'jankurai-release-2026.pub';
function inventory(t, { targets = ['x86_64-unknown-linux-gnu'], signed = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-inventory-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dist = path.join(root, 'dist'); fs.mkdirSync(dist);
  const linux = targets.includes('x86_64-unknown-linux-gnu');
  if (linux) for (const name of ['family.lock', 'Cargo.lock', 'jankurai-installer.sh', 'jankurai-ux-qa-1.7.2.tgz']) fs.writeFileSync(path.join(dist, name), name);
  for (const target of targets) {
    fs.writeFileSync(path.join(dist, `provenance-${target}.json`), '{}');
    for (const product of ['jankurai', 'tuiwright']) {
      const stem = `${product}-1.7.2-${target}`, stage = path.join(root, stem); fs.mkdirSync(stage);
      for (const name of [product, 'LICENSE', 'family.lock', 'Cargo.lock', 'provenance.json']) fs.writeFileSync(path.join(stage, name), name);
      assert.equal(spawnSync('tar', ['-czf', path.join(dist, `${stem}.tar.gz`), '-C', root, stem]).status, 0);
    }
  }
  for (const name of fs.readdirSync(dist)) {
    fs.writeFileSync(path.join(dist, name + '.sha256'), `${createHash('sha256').update(fs.readFileSync(path.join(dist, name))).digest('hex')}  ${name}\n`);
    // Cryptographic verification is ops/release/verify-release.sh's job.
    if (signed) fs.writeFileSync(path.join(dist, name + '.cosign.bundle'), 'fixture signature');
  }
  if (signed) fs.writeFileSync(path.join(dist, KEY), 'fixture key');
  const verify = (options = {}) => verifyInventory(dist, { tag: 'v1.7.2', unsigned: !signed, ...options });
  return { root, dist, verify };
}
test('a Linux-only signed inventory is complete; extra files are refused', t => {
  const f = inventory(t); assert.deepEqual(f.verify().targets, ['x86_64-unknown-linux-gnu']);
  fs.writeFileSync(path.join(f.dist, 'jankurai-governed-launcher'), 'internal');
  assert.throws(() => f.verify(), /unexpected release asset inventory \(extra: jankurai-governed-launcher/);
});
test('macOS assets are optional but must be complete when present', t => {
  const f = inventory(t, { targets: ['x86_64-unknown-linux-gnu', 'aarch64-apple-darwin'] });
  assert.deepEqual(f.verify().targets, ['x86_64-unknown-linux-gnu', 'aarch64-apple-darwin']);
  fs.rmSync(path.join(f.dist, 'tuiwright-1.7.2-aarch64-apple-darwin.tar.gz'));
  assert.throws(() => f.verify(), /missing product: tuiwright-1\.7\.2-aarch64-apple-darwin/);
});
test('the Linux build is required', t => {
  const f = inventory(t, { targets: ['aarch64-apple-darwin'] });
  assert.throws(() => f.verify(), /missing required x86_64-unknown-linux-gnu build/);
});
test('signed inventories need every key bundle and exactly the pinned key file', t => {
  const f = inventory(t);
  fs.unlinkSync(path.join(f.dist, 'family.lock.cosign.bundle'));
  assert.throws(() => f.verify(), /missing: family\.lock\.cosign\.bundle/);
  fs.writeFileSync(path.join(f.dist, 'family.lock.cosign.bundle'), 'fixture signature');
  fs.renameSync(path.join(f.dist, KEY), path.join(f.dist, 'other.pub'));
  assert.throws(() => f.verify(), /extra: other\.pub; missing: jankurai-release-2026\.pub/);
});
test('linked metadata and checksum drift are refused', t => {
  const f = inventory(t);
  const lock = path.join(f.dist, 'family.lock'), outside = path.join(f.root, 'lock');
  fs.renameSync(lock, outside); fs.symlinkSync(outside, lock);
  assert.throws(() => f.verify(), /non-regular release asset: family\.lock/);
  fs.unlinkSync(lock); fs.writeFileSync(lock, 'changed');
  assert.throws(() => f.verify(), /checksum mismatch: family\.lock/);
});
test('signing input must be unsigned and complete, and cannot pass as signed output', t => {
  const f = inventory(t, { signed: false });
  assert.equal(f.verify().assets.length, 7);
  assert.throws(() => f.verify({ unsigned: false }), /missing: .*cosign\.bundle/);
  fs.writeFileSync(path.join(f.dist, KEY), 'early key');
  assert.throws(() => f.verify(), /extra: jankurai-release-2026\.pub/);
  fs.unlinkSync(path.join(f.dist, KEY)); fs.unlinkSync(path.join(f.dist, 'family.lock.sha256'));
  assert.throws(() => f.verify(), /missing: family\.lock\.sha256/);
});
test('the tag must be a plain release version', t => {
  const f = inventory(t);
  assert.throws(() => f.verify({ tag: '1.7.2' }), /release tag/);
});
