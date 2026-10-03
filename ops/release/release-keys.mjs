// The installer's pinned release-key table is the single source of truth for
// which public key signs which tags. Signing, verification and publication read
// it from here so a release can never be signed with a key the installer rejects.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const hub = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const TAG = /^v(\d+)\.(\d+)\.(\d+)(?:[.-][A-Za-z0-9.-]+)?$/;
const UNPROVISIONED = /^0{64}$/;

export function versionNumber(tag) {
  const match = TAG.exec(tag);
  if (!match) throw new Error(`invalid version tag: ${tag}`);
  return Number(match[1]) * 1e6 + Number(match[2]) * 1e3 + Number(match[3]);
}

// Only tags after v1.7.1 are key-signed; earlier tags keep their keyless identity.
export const keySigned = tag => versionNumber(tag) > versionNumber('v1.7.1');

export function parseKeyTable(installerText) {
  const match = /^release_keys='\n([\s\S]*?)^'$/m.exec(installerText);
  if (!match) throw new Error('installer has no release_keys table');
  return match[1].split('\n').filter(Boolean).map(line => {
    const [name, sha256, first, last, ...rest] = line.split('|');
    if (rest.length || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.pub$/.test(name ?? '') || !/^[0-9a-f]{64}$/.test(sha256 ?? '')) {
      throw new Error(`malformed release key entry: ${line}`);
    }
    versionNumber(first);
    if (last) versionNumber(last);
    return { name, sha256, first, last: last || null };
  });
}

export function selectKey(installerText, tag) {
  if (!keySigned(tag)) throw new Error(`${tag} predates key signing and keeps its keyless identity`);
  const n = versionNumber(tag);
  const covering = parseKeyTable(installerText).filter(key =>
    n >= versionNumber(key.first) && (!key.last || n <= versionNumber(key.last)));
  if (covering.length !== 1) throw new Error(`expected exactly one release signing key for ${tag}, found ${covering.length}`);
  return { ...covering[0], provisioned: !UNPROVISIONED.test(covering[0].sha256) };
}

export const sha256File = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Resolve the committed public key for a tag and prove it matches the installer pin.
export function pinnedKey(tag, root = hub) {
  const key = selectKey(fs.readFileSync(path.join(root, 'jankurai-installer.sh'), 'utf8'), tag);
  if (!key.provisioned) throw new Error(`release signing key ${key.name} is not provisioned; run ops/release/generate-signing-key.sh`);
  const file = path.join(root, 'release-keys', key.name);
  const info = fs.lstatSync(file);
  if (!info.isFile()) throw new Error(`release key is not a regular file: ${file}`);
  if (sha256File(file) !== key.sha256) throw new Error(`release-keys/${key.name} does not match the installer pin`);
  return { ...key, file };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, tag, root] = process.argv.slice(2);
    if (command === 'pinned' && tag) {
      const key = pinnedKey(tag, root ?? hub);
      console.log(`${key.name} ${key.sha256} ${key.file}`);
    } else if (command === 'select' && tag) {
      const key = selectKey(fs.readFileSync(path.join(root ?? hub, 'jankurai-installer.sh'), 'utf8'), tag);
      console.log(`${key.name} ${key.sha256} ${key.provisioned ? 'provisioned' : 'unprovisioned'}`);
    } else if (command === 'key-signed' && tag) {
      process.exitCode = keySigned(tag) ? 0 : 1;
    } else throw new Error('usage: release-keys.mjs pinned|select|key-signed <tag> [hub]');
  } catch (error) { console.error(`release keys: ${error.message}`); process.exitCode = 2; }
}
