import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { objectGit as git } from './family-object-view.mjs';
import { prepareSource } from '../ops/release/prepare-source.mjs';
import { materialize, verify, memberRoot } from '../ops/release/compose-source.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-source-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hub = path.join(root, 'jankurai'), member = path.join(root, 'jankurai-core');
  const commit = directory => {
    git(directory, ['add', '.']); git(directory, ['-c', 'user.name=fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'source']);
    return git(directory, ['rev-parse', 'HEAD']);
  };
  for (const dir of [hub, member]) {
    fs.mkdirSync(dir); git(dir, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'target/\n');
    fs.writeFileSync(path.join(dir, 'VERSION'), '1.7.5\n');
  }
  fs.writeFileSync(path.join(member, 'build.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const sha = commit(member); git(member, ['tag', 'fixture', sha]);
  fs.writeFileSync(path.join(hub, 'repos.manifest.toml'), `[[repo]]\nname="jankurai-core"\nhosted="file://${member}"\ngithub="file://${member}"\ndefault_branch="main"\n`);
  fs.writeFileSync(path.join(hub, 'family.lock'), `[[repo]]\nrepo="jankurai-core"\ntag="fixture"\ncommit="${sha}"\n`);
  const head = commit(hub); git(hub, ['tag', 'v1.7.5', head]); git(hub, ['update-ref', 'refs/remotes/origin/main', head]);
  const sweep = path.join(root, 'lanes'); fs.writeFileSync(sweep, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { root, hub, member, head, sha, sweep };
}
test('release uses one owned worktree and exact exported member bytes without a member checkout', t => {
  const f = fixture(t), src = prepareSource(f.hub, 'v1.7.5', f.head, 'release-v1.7.5-x86_64-unknown-linux-gnu', { sweep: f.sweep });
  try {
    materialize(src, f.root); verify(src, f.head);
    assert.equal(path.dirname(src), path.join(f.hub, '.agent/worktrees'));
    const dir = path.join(memberRoot(src), 'jankurai-core');
    assert.equal(fs.existsSync(path.join(dir, '.git')), false);
    assert.equal(fs.readFileSync(path.join(dir, 'VERSION'), 'utf8'), '1.7.5\n');
    assert.ok(fs.statSync(path.join(dir, 'build.sh')).mode & 0o111);
    const count = git(f.hub, ['worktree', 'list', '--porcelain']).split('\n').filter(x => x.startsWith('worktree ')).length;
    assert.equal(count, 2);
    assert.throws(() => prepareSource(f.hub, 'v1.7.5', f.head, 'release-v1.7.5-x86_64-unknown-linux-gnu', { sweep: f.sweep }), /lane exists/);
    assert.throws(() => materialize(src, f.root), /refusing to replace/);
    fs.writeFileSync(path.join(dir, 'VERSION'), 'tampered');
    assert.throws(() => verify(src, f.head), /committed build input changed/);
  } finally {
    // Preserve output before removing the test worktree through Git.
    fs.renameSync(path.join(src, 'target'), path.join(f.root, 'preserved-target'));
    git(f.hub, ['worktree', 'unlock', src]); git(f.hub, ['worktree', 'remove', src]);
    assert.ok(fs.existsSync(path.join(f.root, 'preserved-target/release-members/jankurai-core/VERSION')));
  }
});
test('tag mismatch and unknown expected commit fail before a source lane is created', t => {
  const f = fixture(t);
  assert.throws(() => prepareSource(f.hub, 'v1.7.5', 'a'.repeat(40), 'release-v1.7.5-x86_64-unknown-linux-gnu', { sweep: f.sweep }), /expected/);
  assert.throws(() => prepareSource(f.hub, 'v1.7.5', '', 'release-v1.7.5-x86_64-unknown-linux-gnu', { sweep: f.sweep }), /exact expected commit/);
  assert.equal(fs.existsSync(path.join(f.hub, '.agent/worktrees/release-v1.7.5-x86_64-unknown-linux-gnu')), false);
});
test('unexpected generated source and linked committed inputs fail post-build verification', t => {
  const f = fixture(t); materialize(f.hub, f.root);
  const dir = path.join(memberRoot(f.hub), 'jankurai-core');
  fs.writeFileSync(path.join(dir, 'extra.rs'), 'unexpected');
  assert.throws(() => verify(f.hub, f.head), /unexpected generated source/);
  fs.unlinkSync(path.join(dir, 'extra.rs'));
  fs.unlinkSync(path.join(dir, 'VERSION')); fs.symlinkSync(path.join(f.member, 'VERSION'), path.join(dir, 'VERSION'));
  assert.throws(() => verify(f.hub, f.head), /committed build input changed/);
});
