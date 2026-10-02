import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { publishRelease, promoteRelease, PROMOTION_JOBS } from '../ops/ci/publish-release.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-publish-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const file of ['binary.tar.gz', 'binary.tar.gz.sha256']) fs.writeFileSync(path.join(directory, file), file);
  const options = { directory, repository: 'neverhuman/jankurai-audit', tag: 'v1.7.0', version: '1.7.0', commit: 'a'.repeat(40), notes: 'Reviewed release notes' };
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: `refs/tags/${options.tag}`, GITHUB_SHA: options.commit,
    GITHUB_REPOSITORY: options.repository, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'promote' };
  const state = { release: null, assets: [], mutations: [], uploads: [], failUpload: false, tag: options.commit,
    nextAssetId: 100, run: { head_sha: options.commit, event: 'push', path: '.github/workflows/release.yml', run_attempt: 2, status: 'in_progress' },
    jobs: [...PROMOTION_JOBS, 'promote'].map((name, index) => ({ name, id: 1000 + index, run_id: 123, run_attempt: 2, head_sha: options.commit,
      status: name === 'promote' ? 'in_progress' : 'completed', conclusion: name === 'promote' ? null : 'success' })) };
  const asset = file => ({ id: state.nextAssetId++, name: path.basename(file), state: 'uploaded', size: fs.statSync(file).size,
    digest: 'sha256:' + createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
  const api = (endpoint, body, method) => {
    if (method) state.mutations.push({ endpoint, body, method });
    if (endpoint.endsWith('/actions/runs/123')) return structuredClone(state.run);
    if (endpoint.includes('/jobs?filter=all&')) return { jobs: structuredClone(state.jobs) };
    if (endpoint.includes('/git/ref/tags/')) return { object: { type: 'commit', sha: state.tag } };
    if (endpoint.includes('/releases/tags/')) return state.release;
    if (endpoint.endsWith('/releases') && method === 'POST') return state.release = { id: 7, tag_name: body.tag_name, draft: body.draft, prerelease: body.prerelease };
    if (endpoint.includes('/assets?')) return structuredClone(state.assets);
    if (endpoint.endsWith('/releases/7') && method === 'PATCH') return state.release = { ...state.release, ...body, immutable: true };
    if (endpoint.endsWith('/releases/7') || endpoint.endsWith('/releases/latest')) return structuredClone(state.release);
    throw new Error('unexpected API call: ' + endpoint);
  };
  const upload = (_repository, _tag, file) => {
    if (state.failUpload) throw new Error('interrupted upload');
    state.uploads.push(path.basename(file)); state.assets.push(asset(file));
  };
  return { options, env, state, asset, api, run: () => publishRelease(options, api, upload), promote: () => promoteRelease(options, env, api) };
}
test('publication uploads a complete draft and exposes only an immutable prerelease', t => {
  const f = fixture(t), release = f.run();
  assert.equal(release.immutable, true); assert.equal(release.draft, false); assert.equal(release.prerelease, true);
  assert.equal(f.state.uploads.length, 2);
  assert.deepEqual(f.state.mutations.map(x => x.method), ['POST', 'PATCH']);
  assert.deepEqual(f.state.mutations.at(-1).body, { draft: false, prerelease: true, make_latest: 'false' });
  assert.ok(f.state.mutations.every(x => x.body.make_latest === 'false'));
});
test('retry preserves a matching partial draft and uploads only missing assets', t => {
  const f = fixture(t); f.state.release = { id: 7, tag_name: 'v1.7.0', draft: true, prerelease: true };
  f.state.assets.push(f.asset(path.join(f.options.directory, 'binary.tar.gz')));
  f.state.failUpload = true; assert.throws(f.run, /interrupted upload/);
  assert.equal(f.state.release.draft, true); assert.equal(f.state.assets.length, 1);
  f.state.failUpload = false; f.run();
  assert.deepEqual(f.state.uploads, ['binary.tar.gz.sha256']);
});
test('conflicting, extra, duplicate, or incomplete upload records are never replaced', t => {
  for (const defect of ['digest', 'extra', 'duplicate', 'duplicate-id', 'invalid-id', 'state']) {
    const f = fixture(t); f.state.release = { id: 7, tag_name: 'v1.7.0', draft: true, prerelease: true };
    const asset = f.asset(path.join(f.options.directory, 'binary.tar.gz'));
    if (defect === 'digest') asset.digest = 'sha256:' + '0'.repeat(64);
    if (defect === 'extra') asset.name = 'unreviewed';
    if (defect === 'state') asset.state = 'starter';
    if (defect === 'invalid-id') asset.id = 0;
    f.state.assets.push(asset); if (defect === 'duplicate') f.state.assets.push(asset);
    if (defect === 'duplicate-id') f.state.assets.push({ ...f.asset(path.join(f.options.directory, 'binary.tar.gz.sha256')), id: asset.id });
    assert.throws(f.run, /existing release asset differs/);
    assert.deepEqual(f.state.uploads, []); assert.deepEqual(f.state.mutations, []);
  }
});
test('a matching published release is read-only and idempotent', t => {
  const f = fixture(t); f.run(); f.state.mutations = []; f.state.uploads = [];
  f.run(); assert.deepEqual(f.state.mutations, []); assert.deepEqual(f.state.uploads, []);
  f.state.assets.pop(); assert.throws(f.run, /inventory is incomplete/);
  assert.deepEqual(f.state.mutations, []);
});
test('wrong source tags and non-immutable published releases fail closed', t => {
  const f = fixture(t); f.state.tag = 'b'.repeat(40);
  assert.throws(f.run, /source commit/); assert.deepEqual(f.state.mutations, []);
  f.state.tag = f.options.commit; f.run(); f.state.release.immutable = false; f.state.mutations = [];
  assert.throws(f.run, /not immutable/); assert.deepEqual(f.state.mutations, []);
});

test('promotion changes only flags after every exact prerequisite succeeds', t => {
  const f = fixture(t); f.run();
  const assets = structuredClone(f.state.assets);
  f.state.mutations = []; f.state.uploads = [];
  assert.equal(f.promote().prerelease, false);
  assert.deepEqual(f.state.mutations, [{ endpoint: 'repos/neverhuman/jankurai-audit/releases/7', method: 'PATCH',
    body: { prerelease: false, make_latest: 'true' } }]);
  assert.deepEqual(f.state.assets, assets); assert.deepEqual(f.state.uploads, []);
  f.state.mutations = [];
  f.promote(); f.run();
  assert.deepEqual(f.state.mutations, []); assert.deepEqual(f.state.uploads, []);
});

for (const lane of PROMOTION_JOBS) {
  for (const outcome of ['failure', 'cancelled', 'skipped', null]) test(`promotion refuses ${lane} outcome ${outcome}`, t => {
    const f = fixture(t); f.run(); f.state.mutations = [];
    f.state.jobs.find(job => job.name === lane).conclusion = outcome;
    assert.throws(f.promote, /prerequisite has not succeeded/);
    assert.equal(f.state.release.prerelease, true); assert.deepEqual(f.state.mutations, []);
  });
}

test('promotion rejects missing, renamed, extra, duplicate, empty and stale-head job collections', t => {
  for (const change of [
    jobs => jobs.slice(1),
    jobs => jobs.map((job, i) => i === 0 ? { ...job, name: 'renamed' } : job),
    jobs => [...jobs, { ...jobs[0], name: 'extra' }],
    jobs => [...jobs.slice(1), jobs[1]],
    () => [],
    jobs => jobs.map((job, i) => i === 0 ? { ...job, head_sha: 'b'.repeat(40) } : job),
    jobs => jobs.map((job, i) => i === 0 ? { ...job, status: 'in_progress' } : job),
  ]) {
    const f = fixture(t); f.run(); f.state.mutations = []; f.state.jobs = change(f.state.jobs);
    assert.throws(f.promote); assert.deepEqual(f.state.mutations, []); assert.equal(f.state.release.prerelease, true);
  }
});

test('promotion refuses a different workflow, attempt, source, event, ref or job', t => {
  for (const change of [
    f => { f.state.run.path = '.github/workflows/ci.yml'; },
    f => { f.state.run.run_attempt = 1; },
    f => { f.state.run.head_sha = 'b'.repeat(40); },
    f => { f.state.run.event = 'workflow_dispatch'; },
    f => { f.state.run.status = 'completed'; f.state.run.conclusion = 'failure'; },
    f => { f.env.GITHUB_REF = 'refs/heads/main'; },
    f => { Object.assign(f.state.jobs.at(-1), { status: 'completed', conclusion: 'failure' }); },
    f => { f.env.GITHUB_JOB = 'publish'; },
    f => { f.env.GITHUB_RUN_ID = ''; },
    f => { f.env.GITHUB_RUN_ATTEMPT = '0'; },
  ]) {
    const f = fixture(t); f.run(); f.state.mutations = []; change(f);
    assert.throws(f.promote); assert.deepEqual(f.state.mutations, []);
  }
});

test('promotion preserves drafts, incomplete inventories and changed tags on refusal', t => {
  for (const change of [
    f => { f.state.release.draft = true; },
    f => { f.state.release.immutable = false; },
    f => { f.state.release.immutable = 'true'; },
    f => { delete f.state.release.draft; },
    f => { f.state.release.prerelease = 'true'; },
    f => { f.state.assets.pop(); },
    f => { f.state.assets[0].digest = 'sha256:' + '0'.repeat(64); },
    f => { f.state.tag = 'b'.repeat(40); },
  ]) {
    const f = fixture(t); f.run(); f.state.mutations = []; change(f);
    assert.throws(f.promote); assert.deepEqual(f.state.mutations, []);
  }
});

test('promotion fails on unavailable GitHub evidence and verifies post-promotion asset identities', t => {
  const f = fixture(t); f.run(); f.state.mutations = [];
  assert.throws(() => promoteRelease(f.options, f.env, () => { throw new Error('API unavailable'); }), /API unavailable/);
  assert.deepEqual(f.state.mutations, []);
  assert.throws(() => promoteRelease(f.options, f.env, (endpoint, body, method) => {
    const result = f.api(endpoint, body, method);
    if (method === 'PATCH') f.state.assets[0].id += 1000;
    return result;
  }), /asset identity changed/);
  assert.equal(f.state.mutations.length, 1); assert.equal(f.state.uploads.length, 2);
});


test('failed-job reruns reuse successful prerequisites from this run without rebuilding immutable assets', t => {
  const f = fixture(t); f.run(); f.state.mutations = []; f.state.uploads = [];
  for (const job of f.state.jobs) if (job.name !== 'promote' && !job.name.startsWith('smoke ')) job.run_attempt = 1;
  const smoke = f.state.jobs.find(job => job.name === 'smoke (ubuntu-24.04)');
  f.state.jobs.push({ ...smoke, id: 2000, run_attempt: 1, conclusion: 'failure' });
  assert.equal(f.promote().prerelease, false);
  assert.deepEqual(f.state.uploads, []);
});

test('an older success cannot hide a later failure or malformed job identity', t => {
  for (const change of [
    f => { f.state.jobs.push({ ...f.state.jobs[0], id: 2000, run_attempt: 1 }); f.state.jobs[0].conclusion = 'failure'; },
    f => { f.state.jobs[0].run_id = 124; },
    f => { f.state.jobs[0].run_attempt = 3; },
    f => { f.state.jobs[0].run_attempt = 0; },
    f => { delete f.state.jobs[0].run_attempt; },
    f => { f.state.jobs[0].id = f.state.jobs[1].id; },
    f => { f.state.jobs.at(-1).run_attempt = 1; },
    f => { f.state.jobs.push({ ...f.state.jobs[0], id: 2000 }); },
  ]) {
    const f = fixture(t); f.run(); f.state.mutations = []; change(f);
    assert.throws(f.promote); assert.deepEqual(f.state.mutations, []); assert.equal(f.state.release.prerelease, true);
  }
});
test('publication and promotion refuse the pre-rename hub repository', t => {
  for (const repository of ['neverhuman/jankurai', 'fork/jankurai-audit']) {
    const f = fixture(t); f.options.repository = repository; f.env.GITHUB_REPOSITORY = repository;
    assert.throws(f.run, /invalid release identity/);
    assert.throws(f.promote, /invalid release identity/);
    assert.deepEqual(f.state.mutations, []);
  }
});
