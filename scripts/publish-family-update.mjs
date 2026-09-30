import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import TOML from '@iarna/toml';
import { Family } from './family-model.mjs';
import { api, successful } from './family-update.mjs';
import { isLink } from './family-lib.mjs';

// The hub's GitHub mirror: family-update automation runs against github.com,
// while the forge (repos.manifest.toml authority) owns root/jankurai itself.
const repository = 'neverhuman/jankurai-audit', files = ['family.lock', 'Cargo.lock'];
const content = (file, ref, request = api) => Buffer.from(request(`repos/${repository}/contents/${file}?ref=${ref}`).content, 'base64').toString();
export const branchFor = candidate => 'automation/family-' + createHash('sha256').update(candidate['family.lock'] + '\0' + candidate['Cargo.lock']).digest('hex').slice(0, 24);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
export function validateCandidate(family, candidate, base, request = api) {
  const old = TOML.parse(base['family.lock']), next = TOML.parse(candidate['family.lock']);
  if (!same(Object.keys(old), Object.keys(next)) || Object.keys(old).some(key => key !== 'repo' && !same(old[key], next[key]))) throw new Error('updater may only change component pins');
  if (old.repo.length !== next.repo.length) throw new Error('candidate changed family membership');
  let changed = false;
  for (let i = 0; i < old.repo.length; i++) {
    const previous = old.repo[i], pin = next.repo[i];
    if (!same(Object.keys(previous), Object.keys(pin)) || Object.keys(previous).some(key => !['tag', 'commit'].includes(key) && !same(previous[key], pin[key]))) throw new Error('candidate changed repository metadata/order');
    if (same(previous, pin)) continue;
    changed = true;
    validatePin(family, pin, request);
  }
  if (!changed) throw new Error('candidate contains no component update');
  const cargo = TOML.parse(candidate['Cargo.lock']);
  if (cargo.version !== 4 || !Array.isArray(cargo.package)) throw new Error('invalid aggregate Cargo lock');
}
function validatePin(family, pin, request) {
  const sha = pin.commit;
  if (!/^[a-f0-9]{40}$/.test(sha) || pin.tag !== `ci-${sha}`) throw new Error('candidate needs an immutable exact-SHA CI tag');
  const repo = family.repos.find(repo => repo.name === pin.repo);
  const ref = request(`repos/${repo.github_slug}/git/ref/tags/${pin.tag}`).object;
  if (ref.type !== 'commit' || ref.sha !== sha) throw new Error('candidate CI tag mismatch');
  const comparison = request(`repos/${repo.github_slug}/compare/${sha}...${repo.default_branch}`);
  if (!['ahead', 'identical'].includes(comparison.status) || !successful(repo, sha, request)) throw new Error('candidate is not a successful default-branch revision');
}
export function publish(family, directory, request = api) {
  const candidate = {};
  for (const file of files) {
    const name = path.join(directory, file);
    if (isLink(name) || !fs.statSync(name).isFile() || fs.statSync(name).size > 2_000_000) throw new Error('invalid candidate artifact');
    candidate[file] = fs.readFileSync(name, 'utf8');
  }
  const baseSha = request(`repos/${repository}/git/ref/heads/main`).object.sha;
  validateCandidate(family, candidate, Object.fromEntries(files.map(file => [file, content(file, baseSha, request)])), request);
  const branch = branchFor(candidate);
  const existing = request(`repos/${repository}/pulls?state=open&head=neverhuman:${branch}`);
  let previousHead;
  if (existing.length) {
    const pr = existing[0];
    const changed = request(`repos/${repository}/pulls/${pr.number}/files?per_page=100`);
    if (pr.head.repo?.full_name !== repository || pr.head.ref !== branch ||
        changed.some(file => !files.includes(file.filename) || file.status !== 'modified')) {
      throw new Error('existing updater PR contains unexpected changes');
    }
    for (const file of files) {
      if (content(file, pr.head.sha, request) !== candidate[file]) throw new Error('existing updater candidate changed');
    }
    const comparison = request(`repos/${repository}/compare/${baseSha}...${pr.head.sha}`);
    if (comparison.merge_base_commit.sha === baseSha) { console.log(pr.html_url); return; }
    previousHead = pr.head.sha;
  }
  const tree = files.map(file => ({ path: file, mode: '100644', type: 'blob', sha:
    request(`repos/${repository}/git/blobs`, { content: candidate[file], encoding: 'utf-8' }).sha }));
  const baseTree = request(`repos/${repository}/git/commits/${baseSha}`).tree.sha;
  const treeSha = request(`repos/${repository}/git/trees`, { base_tree: baseTree, tree }).sha;
  const commit = request(`repos/${repository}/git/commits`, { message: 'Update validated Jankurai family locks', tree: treeSha,
    parents: previousHead ? [previousHead, baseSha] : [baseSha] });
  if (previousHead) {
    request(`repos/${repository}/git/refs/heads/${branch}`, { sha: commit.sha, force: false }, 'PATCH');
    console.log(`Refreshed ${existing[0].html_url}; ordinary PR CI must pass for ${commit.sha}`);
    return;
  }
  request(`repos/${repository}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  const pr = request(`repos/${repository}/pulls`, { title: 'Update validated Jankurai component revisions', head: branch, base: 'main',
    body: 'Automated family update. Changed components have successful required checks and immutable CI tags. Candidate locks passed combined integration in a disposable CI checkout. Ordinary PR CI must pass before a protected merge.' });
  console.log(pr.html_url);
}
function merge(family) {
  const actor = api('user').login, hub = family.repos.find(repo => repo.name === 'jankurai');
  for (const pr of api(`repos/${repository}/pulls?state=open&base=main&per_page=100`)) {
    if (pr.user.login !== actor || pr.head.repo?.full_name !== repository || !pr.head.ref.startsWith('automation/family-') || pr.draft) continue;
    const changed = api(`repos/${repository}/pulls/${pr.number}/files?per_page=100`);
    if (!changed.length || changed.some(file => !files.includes(file.filename) || file.status !== 'modified')) continue;
    const candidate = Object.fromEntries(files.map(file => [file, content(file, pr.head.sha)]));
    const base = Object.fromEntries(files.map(file => [file, content(file, pr.base.sha)]));
    if (branchFor(candidate) !== pr.head.ref) continue;
    validateCandidate(family, candidate, base);
    if (!successful(hub, pr.head.sha)) continue;
    const result = api(`repos/${repository}/pulls/${pr.number}/merge`, { sha: pr.head.sha, merge_method: 'squash' }, 'PUT');
    if (!result.merged) throw new Error('protected updater merge refused');
    console.log(`Merged ${pr.html_url} at ${result.sha}`);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const family = new Family(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    if (process.argv[2] === 'publish') publish(family, path.join(family.hub, 'target/candidate'));
    else if (process.argv[2] === 'merge') merge(family);
    else throw new Error('expected publish or merge');
  } catch (error) { console.error(`family automation: ${error.message}`); process.exitCode = 1; }
}
