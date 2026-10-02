import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function api(endpoint, body) {
  const args = ['api', endpoint];
  if (body !== undefined) args.push('--method', 'POST', '--input', '-');
  const result = spawnSync('gh', args, {
    encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(result.stderr || 'GitHub API failed');
    error.status = Number(/HTTP (\d{3})/.exec(result.stderr)?.[1]);
    throw error;
  }
  return JSON.parse(result.stdout);
}

// Only this workflow's completed aggregate can authorize its exact main source.
// Existing refs are immutable; neither retries nor failures update or delete them.
export function publishCiTag(env = process.env, request = api) {
  const { GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_SHA: sha,
    GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt } = env;
  if (event !== 'push' || ref !== 'refs/heads/main' || repository !== 'neverhuman/jankurai-audit' ||
      !/^[a-f0-9]{40}$/.test(sha ?? '') || !/^[1-9]\d*$/.test(runId ?? '') ||
      !/^[1-9]\d*$/.test(attempt ?? '')) throw new Error('CI tags require the hub main push workflow');
  const prefix = `repos/${repository}`;
  const run = request(`${prefix}/actions/runs/${runId}`);
  if (run.head_sha !== sha || run.head_branch !== 'main' || run.event !== 'push' ||
      run.path !== '.github/workflows/ci.yml' || run.run_attempt !== Number(attempt)) {
    throw new Error('CI run identity mismatch');
  }
  const jobs = [];
  for (let page = 1; ; page++) {
    const result = request(`${prefix}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`);
    if (!Array.isArray(result.jobs)) throw new Error('invalid CI job inventory');
    jobs.push(...result.jobs);
    if (result.jobs.length < 100) break;
    if (page >= 100) throw new Error('CI job inventory exceeds supported bound');
  }
  const required = jobs.filter(job => job.name === 'jankurai/required');
  if (required.length !== 1 || required[0].head_sha !== sha || required[0].status !== 'completed' ||
      required[0].conclusion !== 'success') throw new Error('required aggregate has not succeeded');
  const comparison = request(`${prefix}/compare/${sha}...main`);
  if (!['identical', 'ahead'].includes(comparison.status) || comparison.merge_base_commit?.sha !== sha) {
    throw new Error('qualified source is not on main');
  }
  const tag = `refs/tags/ci-${sha}`, endpoint = `${prefix}/git/ref/tags/ci-${sha}`;
  let existing;
  try { existing = request(endpoint); }
  catch (error) { if (error.status !== 404) throw error; }
  if (existing !== undefined) {
    if (existing.ref !== tag || existing.object?.type !== 'commit' || existing.object.sha !== sha) throw new Error('immutable CI tag mismatch');
    return { ref: tag, sha, created: false };
  }
  const created = request(`${prefix}/git/refs`, { ref: tag, sha });
  if (created.ref !== tag || created.object?.type !== 'commit' || created.object.sha !== sha) {
    throw new Error('created CI tag identity mismatch');
  }
  const verified = request(endpoint);
  if (verified.ref !== tag || verified.object?.type !== 'commit' || verified.object.sha !== sha) {
    throw new Error('published CI tag readback mismatch');
  }
  return { ref: tag, sha, created: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(publishCiTag())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
