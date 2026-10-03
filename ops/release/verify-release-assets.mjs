// Check a release inventory is exactly the public products and their companions.
// Linux x86-64 is required; Apple Silicon macOS is included when its build ran.
// --unsigned checks the signing input; otherwise every asset needs a key bundle
// and the inventory carries exactly the public key the installer pins for the tag.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hub, selectKey } from './release-keys.mjs';

export const TARGETS = ['x86_64-unknown-linux-gnu', 'aarch64-apple-darwin'];

export function verifyInventory(dist, { tag, unsigned = false, root = hub }) {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(tag ?? '');
  if (!match) throw new Error('a release tag vX.Y.Z is required');
  const version = match[1];
  const targets = TARGETS.filter(target => fs.existsSync(path.join(dist, `provenance-${target}.json`)));
  if (!targets.includes(TARGETS[0])) throw new Error(`missing required ${TARGETS[0]} build`);
  const assets = ['family.lock', 'Cargo.lock', 'jankurai-installer.sh', `jankurai-ux-qa-${version}.tgz`];
  for (const target of targets) {
    assets.push(`provenance-${target}.json`);
    for (const product of ['jankurai', 'tuiwright']) {
      const stem = `${product}-${version}-${target}`, name = `${stem}.tar.gz`, file = path.join(dist, name);
      assets.push(name);
      if (!fs.existsSync(file)) throw new Error(`missing product: ${name}`);
      const entries = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n').map(entry => entry.replace(/\/$/, '')).sort();
      const allowed = [stem, ...[product, 'LICENSE', 'family.lock', 'Cargo.lock', 'provenance.json'].map(entry => `${stem}/${entry}`)].sort();
      if (JSON.stringify(entries) !== JSON.stringify(allowed)) throw new Error(`unexpected payload: ${name}`);
      const details = execFileSync('tar', ['-tvzf', file], { encoding: 'utf8' }).trim().split('\n');
      if (details.some(entry => !/^[d-]/.test(entry))) throw new Error(`linked/special payload: ${name}`);
    }
  }
  const key = unsigned ? null : selectKey(fs.readFileSync(path.join(root, 'jankurai-installer.sh'), 'utf8'), tag).name;
  const expected = assets.flatMap(name => unsigned ? [name, `${name}.sha256`] : [name, `${name}.sha256`, `${name}.cosign.bundle`]);
  if (key) expected.push(key);
  expected.sort();
  const actual = fs.readdirSync(dist).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const extra = actual.filter(name => !expected.includes(name)), missing = expected.filter(name => !actual.includes(name));
    throw new Error(`unexpected release asset inventory (extra: ${extra.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'})`);
  }
  for (const name of expected) {
    if (!fs.lstatSync(path.join(dist, name)).isFile()) throw new Error(`non-regular release asset: ${name}`);
  }
  for (const name of assets) {
    const file = path.join(dist, name), digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (fs.readFileSync(`${file}.sha256`, 'utf8') !== `${digest}  ${name}\n`) throw new Error(`checksum mismatch: ${name}`);
    if (!unsigned && !fs.statSync(`${file}.cosign.bundle`).size) throw new Error(`missing signature: ${name}`);
  }
  return { targets, assets };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [dist, ...rest] = process.argv.slice(2);
    const unsigned = rest.includes('--unsigned'), tag = rest[rest.indexOf('--tag') + 1];
    if (!dist || !rest.includes('--tag') || rest.length !== (unsigned ? 3 : 2)) throw new Error('usage: verify-release-assets.mjs <directory> --tag vX.Y.Z [--unsigned]');
    const { targets, assets } = verifyInventory(dist, { tag, unsigned });
    console.log(`verified ${unsigned ? 'unsigned ' : ''}release inventory: ${assets.length} assets for ${targets.join(', ')}`);
  } catch (error) { console.error(`release inventory: ${error.message}`); process.exitCode = 1; }
}
