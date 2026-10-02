import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function request(endpoint, body, method, missing = false) {
  const args = ['api', endpoint];
  if (method) args.push('--method', method);
  if (body !== undefined) args.push('--input', '-');
  const result = spawnSync('gh', args, { encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body) });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (missing && /\(HTTP 404\)/.test(result.stderr)) return null;
    throw new Error(`GitHub request failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
}
function upload(repository, tag, file) {
  const result = spawnSync('gh', ['release', 'upload', tag, file, '--repo', repository], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('release upload failed; verified draft assets are preserved for retry');
}
function releaseContext({ repository, tag, commit, version, directory }, api) {
  if (repository !== 'neverhuman/jankurai-audit' || !/^\d+\.\d+\.\d+$/.test(version) ||
      tag !== `v${version}` || !/^[0-9a-f]{40}$/.test(commit)) throw new Error('invalid release identity');
  const prefix = `repos/${repository}`;
  const verifyTag = () => {
    let object = api(`${prefix}/git/ref/tags/${tag}`).object;
    for (let depth = 0; object.type === 'tag' && depth < 4; depth++) object = api(`${prefix}/git/tags/${object.sha}`).object;
    if (object.type !== 'commit' || object.sha !== commit) throw new Error('release tag does not identify the verified source commit');
  };
  verifyTag();
  const expected = new Map(fs.readdirSync(directory).sort().map(name => {
    const file = path.join(directory, name);
    if (!fs.lstatSync(file).isFile()) throw new Error(`non-regular release asset: ${name}`);
    return [name, { file, digest: 'sha256:' + createHash('sha256').update(fs.readFileSync(file)).digest('hex'), size: fs.statSync(file).size }];
  }));
  if (!expected.size) throw new Error('empty release inventory');
  const checkAssets = (release, complete) => {
    if (release.tag_name !== tag || !Number.isSafeInteger(release.id) || release.id < 1 ||
        typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean') throw new Error('release identity mismatch');
    const seen = new Map(), ids = new Set();
    for (let page = 1; ; page++) {
      const assets = api(`${prefix}/releases/${release.id}/assets?per_page=100&page=${page}`);
      if (!Array.isArray(assets)) throw new Error('invalid release asset inventory');
      for (const asset of assets) {
        const wanted = expected.get(asset.name);
        if (!wanted || seen.has(asset.name) || ids.has(asset.id) || !Number.isSafeInteger(asset.id) || asset.id < 1 ||
            asset.state !== 'uploaded' || asset.digest !== wanted.digest || asset.size !== wanted.size) {
          throw new Error(`existing release asset differs from verified candidate: ${asset.name}`);
        }
        ids.add(asset.id);
        seen.set(asset.name, { id: asset.id, digest: asset.digest, size: asset.size });
      }
      if (assets.length < 100) break;
      if (page >= 100) throw new Error('release asset inventory exceeds supported bound');
    }
    if (complete && seen.size !== expected.size) throw new Error('release asset inventory is incomplete');
    return seen;
  };
  return { prefix, verifyTag, expected, checkAssets };
}

// Publication exposes the complete immutable candidate for anonymous native tests.
// Stable/latest flags are only changed by promoteRelease after hosted-job admission.
export function publishRelease(options, api = request, put = upload) {
  const { repository, tag, commit, notes } = options;
  const { prefix, verifyTag, expected, checkAssets } = releaseContext(options, api);
  let release = api(`${prefix}/releases/tags/${tag}`, undefined, undefined, true);
  if (!release) release = api(`${prefix}/releases`, {
    tag_name: tag, target_commitish: commit, draft: true, prerelease: true,
    make_latest: 'false', name: `Jankurai ${tag}`, body: notes,
  }, 'POST');
  if (!release.draft) {
    checkAssets(release, true);
    if (release.immutable !== true || typeof release.prerelease !== 'boolean') throw new Error('existing release is not immutable');
    return release;
  }
  const existing = checkAssets(release, false);
  for (const [name, asset] of expected) if (!existing.has(name)) put(repository, tag, asset.file);
  const before = checkAssets(release, true);
  verifyTag();
  const id = release.id;
  api(`${prefix}/releases/${id}`, { draft: false, prerelease: true, make_latest: 'false' }, 'PATCH');
  release = api(`${prefix}/releases/${id}`);
  if (release.id !== id || release.draft !== false || release.prerelease !== true || release.immutable !== true) throw new Error('published release did not become an immutable prerelease');
  sameAssets(before, checkAssets(release, true));
  verifyTag();
  return release;
}

export const PROMOTION_JOBS = Object.freeze([
  'validate',
  'build (ubuntu-24.04, x86_64-unknown-linux-gnu)',
  'build (macos-14, aarch64-apple-darwin)',
  'sign', 'verify',
  'staged-native (ubuntu-24.04)', 'staged-native (macos-14)',
  'publish', 'smoke (ubuntu-24.04)', 'smoke (macos-14)',
]);

function requirePromotionJobs({ repository, tag, commit }, env, api) {
  const { GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_SHA: sha,
    GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt,
    GITHUB_JOB: job } = env;
  if (event !== 'push' || ref !== `refs/tags/${tag}` || sha !== commit || repo !== repository ||
      job !== 'promote' || !/^[1-9]\d*$/.test(runId ?? '') || !/^[1-9]\d*$/.test(attempt ?? '')) {
    throw new Error('promotion requires the release workflow promotion job');
  }
  const prefix = `repos/${repository}/actions/runs/${runId}`;
  const run = api(prefix);
  if (run.head_sha !== commit || run.event !== 'push' || run.path !== '.github/workflows/release.yml' ||
      run.run_attempt !== Number(attempt) || !['in_progress', 'completed'].includes(run.status) ||
      (run.status === 'completed' && run.conclusion !== 'success')) throw new Error('release workflow identity mismatch');
  const jobs = [];
  for (let page = 1; ; page++) {
    const result = api(`${prefix}/jobs?filter=all&per_page=100&page=${page}`);
    if (!Array.isArray(result.jobs)) throw new Error('invalid release job inventory');
    jobs.push(...result.jobs);
    if (result.jobs.length < 100) break;
    if (page >= 100) throw new Error('release job inventory exceeds supported bound');
  }
  // Failed-job reruns retain successful prerequisite jobs from earlier attempts.
  // Use the latest execution of each exact job, never an older success after failure.
  const latest = new Map(), executions = new Set(), ids = new Set();
  for (const item of jobs) {
    const execution = `${item.name}:${item.run_attempt}`;
    if (!Number.isSafeInteger(item.id) || item.id < 1 || ids.has(item.id) ||
        item.run_id !== Number(runId) || item.head_sha !== commit ||
        !Number.isSafeInteger(item.run_attempt) || item.run_attempt < 1 || item.run_attempt > Number(attempt) ||
        executions.has(execution)) throw new Error('invalid or duplicate release job execution');
    ids.add(item.id); executions.add(execution);
    if (!latest.has(item.name) || latest.get(item.name).run_attempt < item.run_attempt) latest.set(item.name, item);
  }
  const names = [...latest.keys()].sort();
  if (JSON.stringify(names) !== JSON.stringify([...PROMOTION_JOBS, 'promote'].sort())) {
    throw new Error('release job inventory must contain every exact native and prerequisite job');
  }
  for (const name of PROMOTION_JOBS) {
    const item = latest.get(name);
    if (item.head_sha !== commit || item.status !== 'completed' || item.conclusion !== 'success') {
      throw new Error(`release prerequisite has not succeeded for this source: ${name}`);
    }
  }
  const promotion = latest.get('promote');
  if (promotion.run_attempt !== Number(attempt) || promotion.head_sha !== commit || !['in_progress', 'completed'].includes(promotion.status) ||
      (promotion.status === 'completed' && promotion.conclusion !== 'success')) {
    throw new Error('promotion job identity mismatch');
  }
}

function sameAssets(before, after) {
  for (const [name, identity] of before) {
    if (JSON.stringify(after.get(name)) !== JSON.stringify(identity)) throw new Error(`release asset identity changed: ${name}`);
  }
}

export function promoteRelease(options, env = process.env, api = request) {
  requirePromotionJobs(options, env, api);
  const { prefix, verifyTag, checkAssets } = releaseContext(options, api);
  let release = api(`${prefix}/releases/tags/${options.tag}`);
  const before = checkAssets(release, true);
  if (release.draft || release.immutable !== true || typeof release.prerelease !== 'boolean') throw new Error('promotion requires an immutable published candidate');
  // An already stable release is a read-only retry, including historical versions.
  if (!release.prerelease) return release;
  verifyTag();
  const id = release.id;
  api(`${prefix}/releases/${id}`, { prerelease: false, make_latest: 'true' }, 'PATCH');
  release = api(`${prefix}/releases/${id}`);
  if (release.id !== id || release.draft !== false || release.prerelease !== false || release.immutable !== true) throw new Error('stable promotion readback mismatch');
  sameAssets(before, checkAssets(release, true));
  verifyTag();
  if (api(`${prefix}/releases/latest`).id !== id) throw new Error('latest release readback mismatch');
  return release;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3 || (process.argv[2] !== undefined && process.argv[2] !== '--promote')) throw new Error('usage: publish-release.mjs [--promote]');
    const options = { repository: process.env.GITHUB_REPOSITORY, tag: process.env.RELEASE_TAG,
      commit: process.env.GITHUB_SHA, version: fs.readFileSync('VERSION', 'utf8').trim(), directory: 'dist',
      notes: fs.readFileSync('docs/release-notes.md', 'utf8') };
    const release = process.argv[2] === '--promote' ? promoteRelease(options) : publishRelease(options);
    console.log(`Verified immutable ${release.prerelease ? 'prerelease' : 'stable release'}: ${release.html_url}`);
  } catch (error) { console.error(`release publication: ${error.message}`); process.exitCode = 1; }
}
