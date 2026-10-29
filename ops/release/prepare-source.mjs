// Allocate one owned, registered hub worktree. Failure never removes source or
// evidence; cleanup is an explicit custody operation after publication.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { objectGit as git } from '../../scripts/family-object-view.mjs';
import { validateCheckout } from '../../scripts/family-worktree.mjs';

export function prepareSource(repository, tag, expected, lane) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || !/^[a-f0-9]{40}$/.test(expected) || (!/^[a-z0-9][a-z0-9._-]{0,80}$/.test(lane) || lane.includes('..'))) throw new Error('release source requires a tag, exact expected commit and safe lane name');
  const { primary } = validateCheckout(fs.realpathSync(repository));
  const commit = git(primary, ['rev-parse', `refs/tags/${tag}^{commit}`]);
  if (commit !== expected) throw new Error(`release tag names ${commit}, expected ${expected}`);
  git(primary, ['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main']);
  const target = path.join(primary, '.agent', 'worktrees', lane);
  if (fs.existsSync(target)) throw new Error(`release lane exists; preserve and inspect it: ${target}`);
  const lanes = git(primary, ['worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree ') && line.slice(9) !== primary);
  if (lanes.length >= 8) throw new Error('repository already has eight worktree lanes');
  const exclude = path.join(primary, '.git/info/exclude');
  const previous = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!previous.split('\n').includes('.agent/')) throw new Error('operator custody preflight must configure .agent/ in .git/info/exclude before release allocation');
  git(primary, ['worktree', 'add', '--detach', '--lock', '--reason', `release source: ${tag}`, target, commit]);
  validateCheckout(target);
  return target;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(prepareSource(...process.argv.slice(2))); }
  catch (error) { console.error(`prepare release source: ${error.message}`); process.exitCode = 1; }
}
