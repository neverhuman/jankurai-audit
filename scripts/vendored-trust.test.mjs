import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { vendoredTrustDisagreements, validateVendoredTrust } from './vendored-trust.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const KEY = 'jankurai-release-2026.pub';
const KEY_BYTES = '-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----\n';
const INSTALLER = '#!/usr/bin/env bash\necho hub installer\n';
const LOCK = (keySha = sha256(KEY_BYTES)) => `path = "jankurai-installer.sh"\nsource_path = "jankurai-installer.sh"\nrelease_signer_name = "${KEY}"\nrelease_signer_sha256 = "${keySha}"\n`;

/** A hub with one release key and installer, and one member that vendors them. */
function fixture(edit, fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vendored-trust-')));
  try {
    const hub = path.join(root, 'jankurai'), member = path.join(root, 'jankurai-deploy');
    fs.mkdirSync(path.join(hub, 'release-keys'), { recursive: true });
    fs.writeFileSync(path.join(hub, 'release-keys', KEY), KEY_BYTES);
    fs.writeFileSync(path.join(hub, 'jankurai-installer.sh'), INSTALLER);
    fs.mkdirSync(path.join(member, 'agent/vendor/release-keys'), { recursive: true });
    fs.writeFileSync(path.join(member, 'agent/vendor/release-keys', KEY), KEY_BYTES);
    fs.writeFileSync(path.join(member, 'jankurai-installer.sh'), INSTALLER);
    fs.writeFileSync(path.join(member, 'agent/vendor/hub-installer.lock'), LOCK());
    // A member without a vendor lock is not judged.
    fs.mkdirSync(path.join(root, 'jankurai-core'));
    edit?.({ hub, member });
    const repos = ['jankurai', 'jankurai-deploy', 'jankurai-core', 'jankurai-paper'].map(name => ({ name, path: name }));
    fn({ hub, repos, path: repo => path.join(root, repo.path), existing: repo => fs.existsSync(path.join(root, repo.path)) });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('a member vendoring the hub installer and key byte-for-byte passes', () => {
  fixture(null, family => { validateVendoredTrust(family); assert.deepEqual(vendoredTrustDisagreements(family), []); });
});

for (const [label, edit, message] of [
  ['a swapped vendored key', ({ member }) => fs.writeFileSync(path.join(member, 'agent/vendor/release-keys', KEY), KEY_BYTES.replace('fixture', 'attacker')),
    /jankurai-deploy: agent\/vendor\/release-keys\/jankurai-release-2026\.pub differs from the hub's release-keys\/jankurai-release-2026\.pub/],
  ['a key and lock swapped together', ({ member }) => {
    const other = KEY_BYTES.replace('fixture', 'attacker');
    fs.writeFileSync(path.join(member, 'agent/vendor/release-keys', KEY), other);
    fs.writeFileSync(path.join(member, 'agent/vendor/hub-installer.lock'), LOCK(sha256(other)));
  }, /release_signer_sha256 is not the SHA-256 of the hub's release-keys\/jankurai-release-2026\.pub/],
  ['an extra vendored key the hub does not have', ({ member }) => fs.writeFileSync(path.join(member, 'agent/vendor/release-keys/attacker.pub'), KEY_BYTES),
    /agent\/vendor\/release-keys\/attacker\.pub is not a hub release key/],
  ['a missing vendored key the lock names', ({ member }) => fs.rmSync(path.join(member, 'agent/vendor/release-keys', KEY)),
    /the lock names jankurai-release-2026\.pub but agent\/vendor\/release-keys\/jankurai-release-2026\.pub is missing/],
  ['an edited vendored installer', ({ member }) => fs.appendFileSync(path.join(member, 'jankurai-installer.sh'), 'echo extra\n'),
    /jankurai-installer\.sh differs from the hub's jankurai-installer\.sh/],
]) {
  test(`${label} is refused`, () => {
    fixture(edit, family => assert.throws(() => validateVendoredTrust(family), message));
  });
}
