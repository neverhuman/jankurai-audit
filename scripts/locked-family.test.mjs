import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Family } from './family-model.mjs';
import { lockedMembers, composeMember } from './locked-family.mjs';
import { pinOnMainProblem } from './pins-on-main.mjs';

const hub = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const git = (dir, ...args) => {
  const out = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim();
};

test('every locked member is fetched from its hosted forge URL at its family.lock pin', () => {
  const family = new Family(hub);
  const members = lockedMembers(family);
  assert.equal(members.length, family.lock.repo.length);
  for (const member of members) {
    const pin = family.pins.get(member.name);
    assert.equal(member.url, `https://git.neverhuman.org/git/root/${member.name}.git`);
    assert.equal(member.commit, pin.commit);
    assert.equal(member.tag, pin.tag);
    assert.equal(member.branch, 'main');
  }
});

function upstream(fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'locked-family-')));
  try {
    const src = path.join(root, 'src');
    fs.mkdirSync(src);
    git(src, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(src, 'VERSION'), '1\n');
    git(src, 'add', 'VERSION');
    git(src, 'commit', '-q', '-m', 'one');
    const merged = git(src, 'rev-parse', 'HEAD');
    git(src, 'checkout', '-q', '-b', 'draft');
    fs.writeFileSync(path.join(src, 'VERSION'), '2\n');
    git(src, 'commit', '-q', '-am', 'draft');
    const draft = git(src, 'rev-parse', 'HEAD');
    git(src, 'tag', `ci-${merged}`, merged);
    git(src, 'tag', `ci-${draft}`, draft);
    git(src, 'checkout', '-q', 'main');
    git(src, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    git(src, 'config', 'uploadpack.allowFilter', 'true');
    fn({ root, url: `file://${src}`, merged, draft });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('a member composes at its pin with its tag and origin/main', () => {
  upstream(({ root, url, merged }) => {
    const dir = path.join(root, 'member');
    composeMember(dir, { url, branch: 'main', tag: `ci-${merged}`, commit: merged });
    assert.equal(git(dir, 'rev-parse', '--is-bare-repository'), 'true');
    assert.equal(git(dir, 'rev-parse', `refs/tags/ci-${merged}^{commit}`), merged);
    assert.equal(git(dir, 'show', `${merged}:VERSION`), '1');
    assert.equal(fs.existsSync(path.join(dir, 'VERSION')), false);
    assert.equal(pinOnMainProblem(dir, merged), null);
  });
});

test('a pin off main still composes, so validate-family can refuse it by name', () => {
  upstream(({ root, url, draft }) => {
    const dir = path.join(root, 'member');
    composeMember(dir, { url, branch: 'main', tag: `ci-${draft}`, commit: draft });
    assert.equal(git(dir, 'rev-parse', `refs/tags/ci-${draft}^{commit}`), draft);
    assert.match(pinOnMainProblem(dir, draft), /is not on origin\/main/);
  });
});

test('a pin the forge does not hold fails the composition', () => {
  upstream(({ root, url }) => {
    assert.throws(() => composeMember(path.join(root, 'member'), { url, branch: 'main', tag: 'ci-x', commit: 'f'.repeat(40) }), /git fetch/);
  });
});

test('a real tag that differs from the lock fails instead of being manufactured', () => {
  upstream(({ root, url, merged, draft }) => {
    assert.throws(() => composeMember(path.join(root, 'member'), { url, branch: 'main', tag: `ci-${merged}`, commit: draft }), /immutable tag.*expected/);
  });
});
test('existing evidence is retained and refused', () => {
  upstream(({ root, url, merged }) => {
    const directory = path.join(root, 'evidence'); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'receipt'), 'keep');
    assert.throws(() => composeMember(directory, { url, branch: 'main', tag: `ci-${merged}`, commit: merged }), /refusing to replace/);
    assert.equal(fs.readFileSync(path.join(directory, 'receipt'), 'utf8'), 'keep');
  });
});
