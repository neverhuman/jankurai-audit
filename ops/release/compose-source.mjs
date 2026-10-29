// Export immutable member build inputs from freshly fetched Git objects. These
// are generated fusion inputs, not editable repositories or additional clones.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import TOML from '@iarna/toml';
import { ObjectView, objectGit as git } from '../../scripts/family-object-view.mjs';
import { composeMember } from '../../scripts/locked-family.mjs';
import { pinOnMainProblem } from '../../scripts/pins-on-main.mjs';

const readToml = file => TOML.parse(fs.readFileSync(file, 'utf8'));
export const memberRoot = hub => path.join(hub, 'target', 'release-members');
export function composition(hub) {
  const manifest = readToml(path.join(hub, 'repos.manifest.toml'));
  const lock = readToml(path.join(hub, 'family.lock'));
  const routes = new Map(manifest.repo.map(repo => [repo.name, repo]));
  const names = new Set();
  return lock.repo.map(pin => {
    const route = routes.get(pin.repo);
    if (!route || !/^jankurai(?:-[a-z]+)*$/.test(pin.repo) || names.has(pin.repo) ||
        !/^[a-f0-9]{40}$/.test(pin.commit) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pin.tag)) throw new Error(`malformed lock entry: ${pin.repo}`);
    names.add(pin.repo);
    return { name: pin.repo, tag: pin.tag, commit: pin.commit, hosted: route.hosted, mirror: route.github,
      branch: route.default_branch, directory: path.join(memberRoot(hub), pin.repo),
      objects: path.join(memberRoot(hub), '.objects', `${pin.repo}.git`) };
  });
}
function sourceUrl(member, source) {
  if (source === 'hosted') return member.hosted;
  if (source === 'mirror') return member.mirror;
  return path.join(path.resolve(source), member.name);
}
function view(member) {
  const io = new ObjectView(); io.add(member.directory, member.objects, member.commit); return io;
}
export function materialize(hub, source = 'hosted') {
  const parent = path.join(hub, 'target');
  if (fs.existsSync(parent) && fs.realpathSync(parent) !== parent) throw new Error('refusing redirected release target');
  if (fs.existsSync(memberRoot(hub))) throw new Error('refusing to replace release member evidence');
  for (const member of composition(hub)) {
    if (fs.existsSync(member.directory)) throw new Error(`refusing to replace build inputs: ${member.directory}`);
    composeMember(member.objects, { ...member, url: sourceUrl(member, source) });
    const problem = pinOnMainProblem(member.objects, member.commit, member.branch);
    if (problem) throw new Error(`${member.name}: ${problem}`);
    const io = view(member);
    for (const [name, entry] of io.trees.get(member.directory).entries) {
      // Generated build inputs may never redirect a read outside their tree.
      if (!['100644', '100755'].includes(entry.mode) || entry.type !== 'blob' ||
          name.split('/').some(part => ['.', '..', '.git'].includes(part))) throw new Error(`${member.name}: unsupported source entry ${name}`);
      const destination = path.join(member.directory, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, io.readFileSync(destination), { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
      fs.chmodSync(destination, entry.mode === '100755' ? 0o755 : 0o644);
    }
    console.error(`materialized ${member.name} ${member.commit}`);
  }
}
export function verify(hub, commit) {
  if (git(hub, ['rev-parse', 'HEAD']) !== commit) throw new Error('hub HEAD differs from the release commit');
  if (git(hub, ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('hub source tree changed during the build');
  for (const member of composition(hub)) {
    if (fs.realpathSync(member.directory) !== member.directory || fs.existsSync(path.join(member.directory, '.git'))) throw new Error(`${member.name}: build input path changed`);
    if (git(member.objects, ['rev-parse', `refs/tags/${member.tag}^{commit}`]) !== member.commit) throw new Error(`${member.name}: immutable tag changed`);
    const problem = pinOnMainProblem(member.objects, member.commit, member.branch);
    if (problem) throw new Error(`${member.name}: ${problem}`);
    const io = view(member), entries = io.trees.get(member.directory).entries;
    for (const [name, entry] of entries) {
      const file = path.join(member.directory, name), st = fs.lstatSync(file);
      if (!st.isFile() || fs.realpathSync(file) !== file || (st.mode & 0o111) !== (entry.mode === '100755' ? 0o111 : 0) ||
          !fs.readFileSync(file).equals(io.readFileSync(file))) throw new Error(`${member.name}: committed build input changed: ${name}`);
    }
    function checkExtras(directory, relative = '') {
      for (const name of fs.readdirSync(directory)) {
        const file = path.join(directory, name), rel = relative ? `${relative}/${name}` : name;
        if (entries.has(rel)) continue;
        const st = fs.lstatSync(file);
        if (st.isDirectory() && ['node_modules', 'target', 'dist', 'build', '.jankurai'].includes(name)) continue;
        if (st.isDirectory()) checkExtras(file, rel);
        else throw new Error(`${member.name}: unexpected generated source: ${rel}`);
      }
    }
    checkExtras(member.directory);
  }
  return [{ repo: 'jankurai', commit }, ...composition(hub).map(m => ({ repo: m.name, commit: m.commit }))];
}
// Use the tag's own fusion generator and build implementation. Only the source
// provider changes: verified exported objects replace bootstrap's extra clones.
export async function build(hub, target, command = 'build') {
  const commit = git(hub, ['rev-parse', 'HEAD']); verify(hub, commit);
  const { Family } = await import(pathToFileURL(path.join(hub, 'scripts/family-model.mjs')));
  const { build: buildFamily } = await import(pathToFileURL(path.join(hub, 'scripts/family-build.mjs')));
  const family = new Family(hub);
  family.root = memberRoot(hub);
  family.bootstrap = () => verify(hub, commit);
  family.existing = repo => {
    if (repo.name === 'jankurai') return true;
    const member = composition(hub).find(m => m.name === repo.name);
    if (!member || !fs.existsSync(member.directory)) throw new Error(`missing immutable member: ${repo.name}`);
    return true;
  };
  if (command === 'fuse') family.fuse();
  else await buildFamily(family, { release: true, target });
  verify(hub, commit);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, hub, extra] = process.argv.slice(2);
    if (command === 'materialize' && hub) materialize(path.resolve(hub), extra ?? 'hosted');
    else if (command === 'verify' && hub && /^[a-f0-9]{40}$/.test(extra ?? '')) verify(path.resolve(hub), extra);
    else if (['build', 'fuse'].includes(command) && hub) await build(path.resolve(hub), extra, command);
    else throw new Error('usage: compose-source.mjs materialize <hub> [hosted|mirror|<checkout-root>] | verify <hub> <commit> | build <hub> <target> | fuse <hub>');
  } catch (error) { console.error(`compose source: ${error.message}`); process.exitCode = 1; }
}
