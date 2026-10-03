import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { publish, readToken, releaseCommit, githubClient } from '../ops/release/publish-github-release.mjs';

const hub = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const commit = 'a'.repeat(40);
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-publish-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const file of ['binary.tar.gz', 'binary.tar.gz.sha256', 'binary.tar.gz.cosign.bundle']) fs.writeFileSync(path.join(directory, file), file);
  const options = { directory, tag: 'v1.7.2', commit, notes: 'Reviewed release notes' };
  const state = { release: null, assets: [], mutations: [], uploads: [], logs: [], failUpload: false, tag: commit, nextAssetId: 100, missingTag: false };
  const asset = file => ({ id: state.nextAssetId++, name: path.basename(file), state: 'uploaded', size: fs.statSync(file).size,
    digest: 'sha256:' + createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
  const api = async (method, endpoint, body, allowMissing) => {
    if (method !== 'GET') state.mutations.push({ method, endpoint, body });
    if (endpoint.includes('/git/ref/tags/')) return state.missingTag && allowMissing ? null : { object: { type: 'commit', sha: state.tag } };
    if (endpoint.includes('/releases/tags/')) return state.release;
    if (endpoint.endsWith('/releases') && method === 'POST') return state.release = { id: 7, tag_name: body.tag_name, draft: body.draft, prerelease: body.prerelease };
    if (endpoint.includes('/assets?')) return structuredClone(state.assets);
    if (endpoint.endsWith('/releases/7') && method === 'PATCH') return state.release = { ...state.release, ...body, html_url: 'https://example.invalid/r/7' };
    if (endpoint.endsWith('/releases/7')) return structuredClone(state.release);
    throw new Error('unexpected API call: ' + endpoint);
  };
  const upload = async (_release, name, file) => {
    if (state.failUpload) throw new Error('interrupted upload');
    state.uploads.push(name); state.assets.push(asset(file));
  };
  const run = (extra = {}) => publish({ ...options, ...extra }, api, upload, line => state.logs.push(line));
  return { options, state, asset, run };
}
test('publication creates a draft, uploads every asset, then publishes it as latest', async t => {
  const f = fixture(t); const release = await f.run();
  assert.equal(release.draft, false);
  assert.deepEqual(f.state.uploads.sort(), ['binary.tar.gz', 'binary.tar.gz.cosign.bundle', 'binary.tar.gz.sha256']);
  assert.deepEqual(f.state.mutations.map(m => m.method), ['POST', 'PATCH']);
  assert.equal(f.state.mutations[0].body.draft, true);
  assert.equal(f.state.mutations[0].body.target_commitish, commit);
  assert.deepEqual(f.state.mutations[1].body, { draft: false, prerelease: false, make_latest: 'true' });
});
test('--no-latest publishes without taking the latest flag', async t => {
  const f = fixture(t); await f.run({ latest: false });
  assert.equal(f.state.mutations.at(-1).body.make_latest, 'false');
});
test('a dry run makes no writes and reports the plan', async t => {
  const f = fixture(t); assert.equal(await f.run({ dryRun: true }), null);
  assert.deepEqual(f.state.mutations, []); assert.deepEqual(f.state.uploads, []);
  assert.match(f.state.logs.join('\n'), /would create draft release "Jankurai v1\.7\.2"/);
  assert.equal(f.state.logs.filter(line => /would upload/.test(line)).length, 3);
});
test('a retry resumes a matching partial draft and uploads only missing assets', async t => {
  const f = fixture(t); f.state.failUpload = true;
  await assert.rejects(f.run(), /interrupted upload/);
  f.state.failUpload = false; f.state.assets.push(f.asset(path.join(f.options.directory, 'binary.tar.gz')));
  await f.run();
  assert.deepEqual(f.state.uploads.sort(), ['binary.tar.gz.cosign.bundle', 'binary.tar.gz.sha256']);
  assert.equal(f.state.mutations.filter(m => m.method === 'POST').length, 1);
});
test('conflicting or extra uploaded assets are never replaced', async t => {
  const f = fixture(t); f.state.release = { id: 7, tag_name: 'v1.7.2', draft: true };
  f.state.assets.push({ ...f.asset(path.join(f.options.directory, 'binary.tar.gz')), digest: 'sha256:' + '0'.repeat(64) });
  await assert.rejects(f.run(), /differs from the verified inventory: binary\.tar\.gz/);
  f.state.assets = [{ id: 1, name: 'extra.bin', state: 'uploaded', size: 1, digest: 'sha256:x' }];
  await assert.rejects(f.run(), /extra\.bin/);
  assert.deepEqual(f.state.mutations, []);
});
test('a matching published release is idempotent; a mismatching one is refused', async t => {
  const f = fixture(t); await f.run(); const writes = f.state.mutations.length;
  await f.run(); assert.equal(f.state.mutations.length, writes);
  fs.writeFileSync(path.join(f.options.directory, 'binary.tar.gz'), 'rebuilt');
  await assert.rejects(f.run(), /differs from the verified inventory/);
});
test('the GitHub tag must exist and name the built commit', async t => {
  const f = fixture(t); f.state.tag = 'b'.repeat(40);
  await assert.rejects(f.run(), /is not the built commit/);
  f.state.missingTag = true;
  await assert.rejects(f.run(), /mirror must carry it/);
  assert.deepEqual(f.state.mutations, []);
});
test('only the hub mirror and plain release tags are publishable', async t => {
  const f = fixture(t);
  await assert.rejects(f.run({ repository: 'neverhuman/jankurai' }), /invalid release identity/);
  await assert.rejects(f.run({ tag: 'v1.7.2-rc1' }), /invalid release identity/);
});
test('release commit comes from agreeing v2 provenance files', t => {
  const f = fixture(t), dir = f.options.directory;
  const write = (target, data) => fs.writeFileSync(path.join(dir, `provenance-${target}.json`), JSON.stringify(data));
  assert.throws(() => releaseCommit(dir, 'v1.7.2'), /lacks Linux provenance/);
  write('x86_64-unknown-linux-gnu', { schema: 'jankurai.release/v2', tag: 'v1.7.2', commit });
  assert.equal(releaseCommit(dir, 'v1.7.2'), commit);
  write('aarch64-apple-darwin', { schema: 'jankurai.release/v2', tag: 'v1.7.2', commit: 'c'.repeat(40) });
  assert.throws(() => releaseCommit(dir, 'v1.7.2'), /disagree/);
  write('aarch64-apple-darwin', { schema: 'jankurai.release/v1', tag: 'v1.7.2', commit });
  assert.throws(() => releaseCommit(dir, 'v1.7.2'), /not provenance for v1\.7\.2/);
});
test('the token file must be private, regular and hold one token', t => {
  const f = fixture(t), file = path.join(f.options.directory, 'token');
  fs.writeFileSync(file, 'ghp_fixture\n', { mode: 0o600 });
  assert.equal(readToken(file), 'ghp_fixture');
  fs.chmodSync(file, 0o640); assert.throws(() => readToken(file), /group\/others/);
  fs.chmodSync(file, 0o600); fs.symlinkSync(file, `${file}.link`);
  assert.throws(() => readToken(`${file}.link`), /not a link/);
  fs.writeFileSync(file, 'two tokens\n'); assert.throws(() => readToken(file), /exactly one token/);
});
test('a dry-run client refuses every write even with a token', async () => {
  const { api, upload } = githubClient('ghp_fixture', { readOnly: true });
  await assert.rejects(api('POST', 'repos/x/y/releases', {}), /dry run/);
  await assert.rejects(upload({ id: 1 }, 'a', '/dev/null'), /dry run/);
  await assert.rejects(githubClient(null).api('PATCH', 'repos/x/y/releases/1', {}), /without a token/);
});
test('the CLI refuses to publish an inventory that does not verify', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [path.join(hub, 'ops/release/publish-github-release.mjs'), '--tag', 'v1.7.2', '--dist', f.options.directory, '--dry-run'],
    { encoding: 'utf8', env: { ...process.env, COSIGN: process.execPath } });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /refusing to publish|not the pinned/);
});
