// The lock, checked against the forge on every required run.
//
// `validate-family --checkouts --pins-on-main` is what proves family.lock: each
// member checkout and its ci-<sha> tag sit at the pinned commit, the pin is
// merged on the member's main, and vendored trust material (deploy's installer
// and release keys) is byte-for-byte the hub's. It needs every member checked
// out beside the hub, which the offline lane (fast.sh) does not have. This
// script builds that layout in target/locked-family: the hub at this
// checkout's committed HEAD, and each member cloned from its hosted URL in
// repos.manifest.toml at its family.lock pin, with origin/main fetched. Then it
// runs validate-family there. Forge credentials, when needed, come from the
// caller's git configuration, as for every other fetch.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Family } from './family-model.mjs';

function git(directory, args, { allowFailure = false } = {}) {
  const out = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
  if (out.status !== 0 && !allowFailure) throw new Error(`git ${args.join(' ')} in ${directory}: ${(out.stderr || '').trim()}`);
  return out.status === 0 ? out.stdout.trim() : null;
}

/** One entry per locked member: where to fetch it from and what to pin. */
export function lockedMembers(family) {
  return family.components().map(repo => {
    const pin = family.pins.get(repo.name);
    if (!pin) throw new Error(`${repo.name}: no family.lock pin`);
    return { name: repo.name, path: repo.path, url: repo.hosted, branch: repo.default_branch, tag: pin.tag, commit: pin.commit };
  });
}

/** Clone one member into `directory` at its pin, with origin/<branch> fetched and the pin's tag made. */
export function composeMember(directory, { url, branch, tag, commit }) {
  fs.mkdirSync(directory, { recursive: true });
  git(directory, ['init', '-q']);
  git(directory, ['remote', 'add', 'origin', url]);
  git(directory, ['fetch', '-q', '--no-tags', '--filter=blob:none', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  if (git(directory, ['cat-file', '-e', `${commit}^{commit}`], { allowFailure: true }) === null) {
    // A pin that is not on main still has to be checked out, so validate-family can name it.
    git(directory, ['fetch', '-q', '--no-tags', '--filter=blob:none', 'origin', commit]);
  }
  git(directory, ['-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', commit]);
  git(directory, ['tag', '-f', tag, commit]);
}

/** Build the scratch family under `work` and return the hub path inside it. */
export function composeLockedFamily(hub, work, { members = lockedMembers(new Family(hub)) } = {}) {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const head = git(hub, ['rev-parse', 'HEAD']);
  const scratchHub = path.join(work, 'jankurai');
  git(work, ['clone', '-q', '--no-local', '--no-checkout', hub, scratchHub]);
  git(scratchHub, ['-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', head]);
  const modules = path.join(hub, 'node_modules');
  if (fs.existsSync(modules)) fs.symlinkSync(modules, path.join(scratchHub, 'node_modules'));
  for (const member of members) composeMember(path.join(work, member.path), member);
  return { scratchHub, head };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hub = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  try {
    if (git(hub, ['status', '--porcelain', '--untracked-files=no'])) {
      console.log('locked-family: uncommitted changes are not checked; this validates the committed HEAD');
    }
    const { scratchHub, head } = composeLockedFamily(hub, path.join(hub, 'target', 'locked-family'));
    console.log(`locked-family: composed every member at its family.lock pin for hub ${head}`);
    const out = spawnSync(process.execPath, [path.join(scratchHub, 'scripts/validate-family.mjs'), '--checkouts', '--pins-on-main'], { stdio: 'inherit' });
    process.exitCode = out.status ?? 1;
  } catch (error) { console.error(`locked-family: ${error.message}`); process.exitCode = 1; }
}
