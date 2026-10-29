// Recognize genuine Git worktrees without accepting a foreign gitfile or symlink.
import fs from 'node:fs';
import path from 'node:path';
import { gitText } from './family-lib.mjs';

export function validateCheckout(directory) {
  const fail = () => { throw new Error(`${directory}: expected a canonical primary checkout or registered host worktree`); };
  const regularPath = file => fs.existsSync(file) && fs.realpathSync(file) === file && !fs.lstatSync(file).isSymbolicLink();
  const dot = path.join(directory, '.git');
  if (!regularPath(directory) || !regularPath(dot)) fail();
  if (gitText(directory, 'rev-parse', '--show-toplevel') !== directory) fail();
  const common = path.resolve(directory, gitText(directory, 'rev-parse', '--git-common-dir'));
  const gitdir = gitText(directory, 'rev-parse', '--absolute-git-dir');
  if (!regularPath(common) || !regularPath(gitdir)) fail();
  if (fs.statSync(dot).isDirectory()) {
    if (common !== dot || gitdir !== dot) fail();
    return { primary: directory, lane: null };
  }
  if (!fs.statSync(dot).isFile() || path.basename(common) !== '.git') fail();
  const primary = path.dirname(common);
  const lanes = path.join(primary, '.agent', 'worktrees');
  if (path.dirname(directory) !== lanes || path.dirname(gitdir) !== path.join(common, 'worktrees')) fail();
  const backlink = path.join(gitdir, 'gitdir');
  if (!regularPath(backlink) || fs.readFileSync(backlink, 'utf8').trim() !== dot) fail();
  const entries = gitText(primary, 'worktree', 'list', '--porcelain', '-z').split('\0');
  if (!entries.includes(`worktree ${directory}`)) fail();
  return { primary, lane: path.basename(directory) };
}
