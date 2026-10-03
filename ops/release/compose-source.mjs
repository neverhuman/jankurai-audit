// Materialize, then re-verify, the exact family.lock composition of a release
// source tree. Members are cloned beside the hub at their locked immutable tags;
// every tag must resolve to its locked commit. Git uses the caller's credentials.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import TOML from '@iarna/toml';

const readToml = file => TOML.parse(fs.readFileSync(file, 'utf8'));
function git(args, options = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export function composition(hub) {
  const manifest = readToml(path.join(hub, 'repos.manifest.toml'));
  const lock = readToml(path.join(hub, 'family.lock'));
  const routes = new Map(manifest.repo.map(repo => [repo.name, repo]));
  return lock.repo.map(pin => {
    const route = routes.get(pin.repo);
    if (!route || !/^[a-f0-9]{40}$/.test(pin.commit) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pin.tag)) {
      throw new Error(`malformed lock entry: ${pin.repo}`);
    }
    return { name: pin.repo, tag: pin.tag, commit: pin.commit, hosted: route.hosted, mirror: route.github,
      directory: path.join(path.dirname(hub), pin.repo) };
  });
}

function sourceUrl(member, source) {
  if (source === 'hosted') return member.hosted;
  if (source === 'mirror') return member.mirror;
  // A directory of existing checkouts, used only as an object source.
  return path.join(path.resolve(source), member.name);
}

export function clone(hub, source = 'hosted') {
  for (const member of composition(hub)) {
    if (fs.existsSync(member.directory)) throw new Error(`refusing to reuse an existing checkout: ${member.directory}`);
    const url = sourceUrl(member, source);
    git(['clone', '--quiet', '--no-checkout', '--no-hardlinks', url, member.directory]);
    git(['-C', member.directory, 'fetch', '--quiet', '--no-tags', url, `+refs/tags/${member.tag}:refs/tags/${member.tag}`]);
    const resolved = git(['-C', member.directory, 'rev-parse', `refs/tags/${member.tag}^{commit}`]);
    if (resolved !== member.commit) throw new Error(`${member.name}: tag ${member.tag} is ${resolved}, lock says ${member.commit}`);
    git(['-C', member.directory, 'checkout', '--quiet', '--detach', member.commit]);
    console.error(`composed ${member.name} ${member.commit}`);
  }
}

// After building, the hub and every member must still be clean and at the pins.
export function verify(hub, commit) {
  const checks = [{ name: 'jankurai', directory: hub, commit }, ...composition(hub)];
  for (const member of checks) {
    const head = git(['-C', member.directory, 'rev-parse', 'HEAD']);
    if (head !== member.commit) throw new Error(`${member.name}: HEAD ${head} is not the locked ${member.commit}`);
    const dirty = git(['-C', member.directory, 'status', '--porcelain', '--untracked-files=normal']);
    if (dirty) throw new Error(`${member.name}: source tree changed during the build\n${dirty}`);
  }
  return checks.map(({ name, commit: locked }) => ({ repo: name, commit: locked }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, hub, extra] = process.argv.slice(2);
    if (command === 'clone' && hub) clone(path.resolve(hub), extra ?? 'hosted');
    else if (command === 'verify' && hub && /^[a-f0-9]{40}$/.test(extra ?? '')) verify(path.resolve(hub), extra);
    else throw new Error('usage: compose-source.mjs clone <hub> [hosted|mirror|<checkout-root>] | verify <hub> <commit>');
  } catch (error) { console.error(`compose source: ${error.message}`); process.exitCode = 1; }
}
