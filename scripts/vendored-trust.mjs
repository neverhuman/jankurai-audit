// Vendored trust material: a member that vendors the hub installer
// (agent/vendor/hub-installer.lock) must carry it, and every release-signing
// public key it vendors (agent/vendor/release-keys/), byte-for-byte as the hub
// has them, with the lock naming the key's real SHA-256. The member's own
// required lane can only prove its files agree with each other; this check,
// run on a composed family checkout, proves they are the hub's.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const VENDOR_LOCK = 'agent/vendor/hub-installer.lock';
export const VENDOR_KEYS = 'agent/vendor/release-keys';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const lockField = (text, key) => text.match(new RegExp(`^${key} = "([^"]*)"$`, 'm'))?.[1];

/** `{ repo, detail }` per present member whose vendored trust material leaves the hub's. */
export function vendoredTrustDisagreements(family, io = fs) {
  const disagreements = [];
  for (const repo of family.repos) {
    if (!family.existing(repo)) continue;
    const directory = family.path(repo);
    const lockPath = path.join(directory, VENDOR_LOCK);
    if (!io.existsSync(lockPath)) continue;
    const add = detail => disagreements.push({ repo: repo.name, detail });
    const lock = io.readFileSync(lockPath, 'utf8');
    const installer = lockField(lock, 'path') ?? 'jankurai-installer.sh';
    const source = lockField(lock, 'source_path') ?? 'jankurai-installer.sh';
    const vendoredInstaller = path.join(directory, installer);
    if (!io.existsSync(vendoredInstaller)) add(`${installer} is missing`);
    else if (!io.readFileSync(vendoredInstaller).equals(io.readFileSync(path.join(family.hub, source)))) {
      add(`${installer} differs from the hub's ${source}`);
    }
    const keyDirectory = path.join(directory, VENDOR_KEYS);
    const keys = io.existsSync(keyDirectory) ? io.readdirSync(keyDirectory).sort() : [];
    for (const name of keys) {
      const hubKey = path.join(family.hub, 'release-keys', name);
      if (!io.existsSync(hubKey)) { add(`${VENDOR_KEYS}/${name} is not a hub release key`); continue; }
      if (!io.readFileSync(path.join(keyDirectory, name)).equals(io.readFileSync(hubKey))) {
        add(`${VENDOR_KEYS}/${name} differs from the hub's release-keys/${name}`);
      }
    }
    const lockedKey = lockField(lock, 'release_signer_name');
    if (lockedKey) {
      const hubKey = path.join(family.hub, 'release-keys', lockedKey);
      if (!keys.includes(lockedKey)) add(`the lock names ${lockedKey} but ${VENDOR_KEYS}/${lockedKey} is missing`);
      if (!io.existsSync(hubKey)) add(`the lock names ${lockedKey}, which is not a hub release key`);
      else if (lockField(lock, 'release_signer_sha256') !== sha256(io.readFileSync(hubKey))) {
        add(`the lock's release_signer_sha256 is not the SHA-256 of the hub's release-keys/${lockedKey}`);
      }
    }
  }
  return disagreements;
}

/** Throw naming every member whose vendored trust material leaves the hub's. */
export function validateVendoredTrust(family, { io = fs } = {}) {
  const disagreements = vendoredTrustDisagreements(family, io);
  if (!disagreements.length) return;
  throw new Error(`vendored trust material differs from the hub in ${new Set(disagreements.map(({ repo }) => repo)).size} member(s):\n  ${disagreements.map(({ repo, detail }) => `${repo}: ${detail}`).join('\n  ')}`);
}
