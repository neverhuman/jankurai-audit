import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pinOnMainProblem, pinsOffMain } from './pins-on-main.mjs';

const git = (dir, ...args) => {
  const out = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim();
};

/** A member with a merged commit on origin/main and an unmerged branch tip. */
function fixture(fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pins-on-main-')));
  try {
    const dir = path.join(root, 'jankurai-deploy');
    fs.mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'one');
    const merged = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'update-ref', 'refs/remotes/origin/main', merged);
    git(dir, 'checkout', '-q', '-b', 'draft');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'draft');
    const draft = git(dir, 'rev-parse', 'HEAD');
    fn({ root, dir, merged, draft });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const family = (root, commit) => ({
  repos: [{ name: 'jankurai-deploy', path: 'jankurai-deploy', default_branch: 'main' }, { name: 'jankurai-paper', path: 'jankurai-paper' }],
  pins: new Map([['jankurai-deploy', { commit }], ['jankurai-paper', { commit }]]),
  path: repo => path.join(root, repo.path),
  existing: repo => fs.existsSync(path.join(root, repo.path)),
});

test('a pin merged on origin/main passes', () => {
  fixture(({ root, dir, merged }) => {
    assert.equal(pinOnMainProblem(dir, merged), null);
    assert.deepEqual(pinsOffMain(family(root, merged)), []);
  });
});

test('a pin at an unmerged branch tip is refused and named', () => {
  fixture(({ root, dir, draft }) => {
    assert.match(pinOnMainProblem(dir, draft), /is not on origin\/main/);
    assert.deepEqual(pinsOffMain(family(root, draft)).map(({ repo }) => repo), ['jankurai-deploy']);
  });
});

test('a checkout without origin/main is refused, not passed', () => {
  fixture(({ dir, merged }) => {
    git(dir, 'update-ref', '-d', 'refs/remotes/origin/main');
    assert.match(pinOnMainProblem(dir, merged), /no refs\/remotes\/origin\/main/);
  });
});

test('an unknown pin is refused, not passed', () => {
  fixture(({ dir }) => {
    assert.match(pinOnMainProblem(dir, '0'.repeat(40)), /cannot check pin|is not on origin\/main/);
  });
});
