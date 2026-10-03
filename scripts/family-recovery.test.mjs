import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { update } from './family-update.mjs';
import { operationRoot, inspect, operation } from './family-operation.mjs';

function git(directory, ...args) {
  const r = spawnSync('/usr/bin/git', ['-C', directory, ...args], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin', HOME: directory, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return r.stdout.trim();
}

function fixture(t) {
  // Match Family's canonical hub path, including macOS /var -> /private/var.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'family-recovery-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hub = path.join(root, 'jankurai'), source = path.join(root, 'jankurai-core');
  fs.mkdirSync(hub); fs.mkdirSync(source);
  git(source, 'init', '--quiet', '-b', 'main');
  fs.writeFileSync(path.join(source, 'file'), 'old');
  git(source, 'add', '.'); git(source, 'commit', '--quiet', '-m', 'first');
  const old = git(source, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(source, 'file'), 'candidate');
  git(source, 'add', '.'); git(source, 'commit', '--quiet', '-m', 'candidate');
  const candidate = git(source, 'rev-parse', 'HEAD');
  const before = `[[repo]]\nrepo = "jankurai-core"\ntag = "ci-${old}"\ncommit = "${old}"\n`;
  fs.writeFileSync(path.join(hub, 'family.lock'), before);
  fs.writeFileSync(path.join(hub, 'Cargo.lock'), 'BEFORE CARGO');
  git(hub, 'init', '--quiet', '-b', 'main');
  git(hub, 'add', '.'); git(hub, 'commit', '--quiet', '-m', 'locks');
  const repo = { name: 'jankurai-core', default_branch: 'main' };
  const family = {
    hub,
    components: () => [repo],
    existing: () => true,
    path: () => source,
    bootstrap: () => {},
    pins: new Map([[repo.name, { commit: old, tag: `ci-${old}` }]]),
  };
  const execute = (testCandidate = () => 'AFTER CARGO', hooks = {}) => {
    try {
      update(family, { eligible: () => candidate, testCandidate, ...hooks });
      return null;
    } catch (e) { return e.message; }
  };
  const read = name => fs.readFileSync(path.join(hub, name), 'utf8');
  return { root, hub, source, before, candidate, family, execute, read, old };
}

test('successful paired write commits both locks and clears the operation', t => {
  const { hub, execute, read, candidate } = fixture(t);
  const error = execute();
  assert.equal(error, null);
  assert.equal(read('Cargo.lock'), 'AFTER CARGO');
  assert.match(read('family.lock'), new RegExp(candidate));
  assert.equal(fs.existsSync(operationRoot(hub)), false);
});

test('concurrent Cargo edit during second exchange failure preserves unknown bytes and journal', t => {
  const { hub, execute, read } = fixture(t);
  const error = execute(undefined, { observe(event, detail) {
    if (event === 'before-atomic-exchange' && detail.name === 'family.lock' && detail.direction === 'replace') {
      fs.writeFileSync(path.join(hub, 'Cargo.lock'), 'UNIQUE EDIT');
      throw new Error('authored second exchange failure');
    }
  } });
  assert.ok(error);
  assert.equal(read('Cargo.lock'), 'UNIQUE EDIT');
  assert.equal(fs.existsSync(operationRoot(hub)), true);
  assert.equal(inspect(hub).locks['Cargo.lock'].class, 'unknown');
});

test('second exchange failure conditionally rolls back only own writes', t => {
  const { execute, read, before } = fixture(t);
  const error = execute(undefined, { observe(event, detail) {
    if (event === 'before-atomic-exchange' && detail.name === 'family.lock' && detail.direction === 'replace') {
      throw new Error('authored second exchange failure');
    }
  } });
  assert.match(error, /authored second exchange failure/);
  assert.equal(read('Cargo.lock'), 'BEFORE CARGO');
  assert.equal(read('family.lock'), before);
});

test('clean HEAD advance during validation rejects acceptance', t => {
  const { source, before, execute, read } = fixture(t);
  const previous = git(source, 'rev-parse', 'HEAD');
  const error = execute(() => {
    fs.writeFileSync(path.join(source, 'file'), 'new source');
    git(source, 'add', '.');
    git(source, 'commit', '--quiet', '-m', 'concurrent clean advance');
    return 'AFTER CARGO';
  });
  assert.ok(error);
  assert.match(error, /HEAD\/tree changed/);
  assert.equal(read('family.lock'), before);
  assert.equal(read('Cargo.lock'), 'BEFORE CARGO');
  assert.notEqual(git(source, 'rev-parse', 'HEAD'), previous);
});

test('same-byte different inode during validation rejects acceptance', t => {
  const { hub, before, execute, read } = fixture(t);
  const file = path.join(hub, 'Cargo.lock');
  const inode = fs.statSync(file).ino;
  let duringInode;
  const error = execute(() => {
    fs.writeFileSync(`${file}.authored`, 'BEFORE CARGO');
    fs.renameSync(`${file}.authored`, file);
    duringInode = fs.statSync(file).ino;
    return 'AFTER CARGO';
  });
  assert.ok(error);
  assert.match(error, /identity changed/);
  assert.notEqual(duringInode, inode);
  assert.equal(read('family.lock'), before);
  assert.equal(read('Cargo.lock'), 'BEFORE CARGO');
});

test('recover inspect works with malformed family.lock', t => {
  const { hub } = fixture(t);
  fs.writeFileSync(path.join(hub, 'family.lock'), '{not-toml');
  operation(hub, (tx) => {
    fs.mkdirSync(path.join(tx.root, 'journal', 'images'), { recursive: true });
    fs.writeFileSync(path.join(tx.root, 'journal', 'journal.json'), `${JSON.stringify({
      schema: 1,
      uuid: '00000000-0000-4000-8000-000000000001',
      generation: 1,
      state: 'needs-recovery',
      source: { hub: { head: 'a'.repeat(40), tree: 'b'.repeat(40) }, components: {} },
      writer: { pid: 1, hostname: 'no-such-host', startTime: '0' },
      locks: {
        'Cargo.lock': { stage: 'original', before: { sha256: '0'.repeat(64), mode: 33188, size: 1, dev: 1, ino: 1 }, after: null },
        'family.lock': { stage: 'original', before: { sha256: '1'.repeat(64), mode: 33188, size: 1, dev: 1, ino: 2 }, after: null },
      },
    }, null, 2)}\n`);
    tx.retain = true;
  });
  // operation retains needs-recovery
  const report = inspect(hub);
  assert.equal(report.present, true);
  assert.equal(report.journal.state, 'needs-recovery');
  assert.ok(report.locks['family.lock']);
  const scripts = path.join(hub, 'scripts');
  fs.mkdirSync(scripts);
  for (const file of ['family.mjs', 'family-operation.mjs', 'family-native.rs', 'family.sh']) {
    fs.copyFileSync(new URL(`./${file}`, import.meta.url), path.join(scripts, file));
  }
  // Copy only the actual command surface into a fixture with no family parser,
  // package manifest, bootstrap script or node_modules. Both public entry paths
  // must inspect the malformed lock without trying any of those dependencies.
  for (const command of [[process.execPath, path.join(scripts, 'family.mjs')], ['bash', path.join(scripts, 'family.sh')]]) {
    const result = spawnSync(command[0], [...command.slice(1), 'recover', 'inspect', '--json'], {
      encoding: 'utf8', cwd: hub, timeout: 10000,
      env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout);
    assert.equal(actual.hub, fs.realpathSync(hub));
    assert.equal(actual.journal.state, 'needs-recovery');
    assert.equal(actual.finishAdmissible, false);
  }
  assert.equal(report.finishAdmissible, false);
  assert.ok(['unknown', 'original', 'unknown-same-bytes', 'unreadable'].includes(report.locks['family.lock'].class)
    || report.locks['family.lock'].class === 'unknown');
});
