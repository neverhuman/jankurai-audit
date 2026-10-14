// Release pins must be merged work. `validate-family --checkouts` proves each
// member checkout sits at its family.lock commit and tag, but a tag can point at
// any commit, including the tip of an unmerged branch. With `--pins-on-main` it
// also requires every pin to be reachable from that member's remote main, read
// from the checkout's own refs/remotes/origin/<default branch> (fetch it first).
import { spawnSync } from 'node:child_process';

/** Null when `commit` is on `refs/remotes/origin/<branch>` in `directory`, otherwise why not. */
export function pinOnMainProblem(directory, commit, branch = 'main') {
  const ref = `refs/remotes/origin/${branch}`;
  const known = spawnSync('git', ['-C', directory, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { encoding: 'utf8' });
  if (known.status !== 0) return `no ${ref} in the checkout; fetch origin ${branch} before checking pins`;
  const ancestor = spawnSync('git', ['-C', directory, 'merge-base', '--is-ancestor', commit, ref], { encoding: 'utf8' });
  if (ancestor.status === 0) return null;
  if (ancestor.status === 1) return `pin ${commit} is not on origin/${branch} (${known.stdout.trim()})`;
  return `cannot check pin ${commit} against origin/${branch}: ${(ancestor.stderr || '').trim()}`;
}

/** `{ repo, detail }` for every present member whose pin is not on its main. */
export function pinsOffMain(family) {
  const problems = [];
  for (const repo of family.repos) {
    const pin = family.pins.get(repo.name);
    if (!pin || !family.existing(repo)) continue;
    const detail = pinOnMainProblem(family.path(repo), pin.commit, repo.default_branch || 'main');
    if (detail) problems.push({ repo: repo.name, detail });
  }
  return problems;
}
