import assert from 'node:assert/strict';
import test from 'node:test';
import { publishCiTag } from './publish-ci-tag.mjs';

const sha = 'a'.repeat(40), tag = `refs/tags/ci-${sha}`;
const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha,
  GITHUB_REPOSITORY: 'neverhuman/jankurai-audit', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' };
function fixture(options = {}) {
  const writes = [], calls = [];
  let existing = options.existing;
  const object = { type: 'commit', sha };
  const request = (endpoint, body) => {
    calls.push(endpoint);
    if (body) {
      writes.push({ endpoint, body });
      assert.equal(endpoint, 'repos/neverhuman/jankurai-audit/git/refs');
      assert.deepEqual(body, { ref: tag, sha });
      existing = { ref: tag, object };
      return existing;
    }
    if (endpoint.endsWith('/actions/runs/123')) return { head_sha: sha, head_branch: 'main', event: 'push',
      path: '.github/workflows/ci.yml', run_attempt: 2, ...options.run };
    if (endpoint.includes('/attempts/2/jobs?')) {
      if (options.paginate && endpoint.endsWith('page=1')) return { jobs: Array.from({ length: 100 }, (_, i) => ({ name: `other-${i}` })) };
      return { jobs: options.jobs ?? [{ name: 'jankurai/required', head_sha: sha, status: 'completed', conclusion: 'success' }] };
    }
    if (endpoint.endsWith(`/compare/${sha}...main`)) return options.comparison ?? { status: 'ahead', merge_base_commit: { sha } };
    if (endpoint.endsWith(`/git/ref/tags/ci-${sha}`)) {
      if (options.readError) throw Object.assign(new Error('API unavailable'), { status: options.readError });
      if (existing) return options.badReadback && writes.length ? { ref: tag, object: { type: 'commit', sha: 'b'.repeat(40) } } : existing;
      throw Object.assign(new Error('not found'), { status: 404 });
    }
    throw new Error(`unexpected request: ${endpoint}`);
  };
  return { request, writes, calls };
}
test('successful exact current-attempt aggregate publishes and reads back a new immutable tag', () => {
  const f = fixture();
  assert.deepEqual(publishCiTag(env, f.request), { ref: tag, sha, created: true });
  assert.equal(f.writes.length, 1);
  assert.equal(f.calls.at(-1), `repos/neverhuman/jankurai-audit/git/ref/tags/ci-${sha}`);
});
test('matching existing tag is an immutable no-op', () => {
  const f = fixture({ existing: { ref: tag, object: { type: 'commit', sha } } });
  assert.equal(publishCiTag(env, f.request).created, false);
  assert.equal(f.writes.length, 0);
});
for (const change of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/repair' },
  { GITHUB_REPOSITORY: 'fork/jankurai' }, { GITHUB_REPOSITORY: 'neverhuman/jankurai' }, { GITHUB_SHA: '' }, { GITHUB_RUN_ID: '0' }, { GITHUB_RUN_ATTEMPT: '1x' }]) {
  test(`reject context ${JSON.stringify(change)} before API access`, () => {
    const f = fixture();
    assert.throws(() => publishCiTag({ ...env, ...change }, f.request), /main push/);
    assert.equal(f.calls.length, 0);
  });
}
for (const run of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'repair' }, { event: 'workflow_dispatch' },
  { path: '.github/workflows/other.yml' }, { run_attempt: 1 }]) {
  test(`reject run identity ${JSON.stringify(run)}`, () => {
    const f = fixture({ run });
    assert.throws(() => publishCiTag(env, f.request), /identity/);
    assert.equal(f.writes.length, 0);
  });
}
for (const conclusion of ['failure', 'cancelled', 'skipped', null]) {
  test(`reject aggregate conclusion ${conclusion}`, () => {
    const f = fixture({ jobs: [{ name: 'jankurai/required', head_sha: sha, status: 'completed', conclusion }] });
    assert.throws(() => publishCiTag(env, f.request), /aggregate/);
    assert.equal(f.writes.length, 0);
  });
}
for (const jobs of [[], [{ name: 'jankurai/required', head_sha: 'b'.repeat(40), status: 'completed', conclusion: 'success' }],
  Array.from({ length: 2 }, () => ({ name: 'jankurai/required', head_sha: sha, status: 'completed', conclusion: 'success' }))]) {
  test(`reject missing, stale, or duplicate aggregate ${JSON.stringify(jobs)}`, () => {
    const f = fixture({ jobs });
    assert.throws(() => publishCiTag(env, f.request), /aggregate/);
    assert.equal(f.writes.length, 0);
  });
}
test('job pagination finds the current-attempt aggregate', () => {
  const f = fixture({ paginate: true });
  assert.equal(publishCiTag(env, f.request).created, true);
  assert.ok(f.calls.some(endpoint => endpoint.endsWith('page=2')));
});
for (const comparison of [{ status: 'diverged', merge_base_commit: { sha } },
  { status: 'ahead', merge_base_commit: { sha: 'b'.repeat(40) } }]) {
  test(`reject non-main source ${JSON.stringify(comparison)}`, () => {
    const f = fixture({ comparison });
    assert.throws(() => publishCiTag(env, f.request), /not on main/);
    assert.equal(f.writes.length, 0);
  });
}
for (const object of [{ type: 'commit', sha: 'b'.repeat(40) }, { type: 'tag', sha }]) {
  test(`preserve conflicting immutable tag ${JSON.stringify(object)}`, () => {
    const f = fixture({ existing: { ref: tag, object } });
    assert.throws(() => publishCiTag(env, f.request), /immutable/);
    assert.equal(f.writes.length, 0);
  });
}
test('a wrong ref name cannot establish an existing-tag no-op', () => {
  const f = fixture({ existing: { ref: 'refs/tags/unrelated', object: { type: 'commit', sha } } });
  assert.throws(() => publishCiTag(env, f.request), /immutable/);
  assert.equal(f.writes.length, 0);
});
test('API failure cannot authorize creation', () => {
  const f = fixture({ readError: 403 });
  assert.throws(() => publishCiTag(env, f.request), /API unavailable/);
  assert.equal(f.writes.length, 0);
});
test('failed readback retains created tag and reports uncertainty without replacement', () => {
  const f = fixture({ badReadback: true });
  assert.throws(() => publishCiTag(env, f.request), /readback/);
  assert.equal(f.writes.length, 1);
});
