// Owner-run publication: create the GitHub release for an existing tag and
// upload a signed, verified inventory. GitHub is only the publishing mirror;
// nothing here builds or signs. See ops/release/publish-github-release.sh.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'neverhuman/jankurai-audit';
const API = 'https://api.github.com', UPLOADS = 'https://uploads.github.com';

export function inventory(directory) {
  const expected = new Map();
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name);
    if (!fs.lstatSync(file).isFile()) throw new Error(`non-regular release asset: ${name}`);
    const bytes = fs.readFileSync(file);
    expected.set(name, { file, size: bytes.length, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') });
  }
  if (!expected.size) throw new Error('empty release inventory');
  return expected;
}

// The source commit every provenance file in the inventory agrees on.
export function releaseCommit(directory, tag) {
  const files = fs.readdirSync(directory).filter(name => /^provenance-.+\.json$/.test(name));
  if (!files.includes('provenance-x86_64-unknown-linux-gnu.json')) throw new Error('inventory lacks Linux provenance');
  const commits = new Set(files.map(name => {
    const provenance = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    if (provenance.schema !== 'jankurai.release/v2' || provenance.tag !== tag) throw new Error(`${name} is not provenance for ${tag}`);
    return provenance.commit;
  }));
  const [commit] = commits;
  if (commits.size !== 1 || !/^[0-9a-f]{40}$/.test(commit)) throw new Error('provenance files disagree on the source commit');
  return commit;
}

export async function publish({ repository = REPOSITORY, tag, commit, directory, notes, latest = true, dryRun = false },
  api, upload, log = console.log) {
  if (repository !== REPOSITORY || !/^v\d+\.\d+\.\d+$/.test(tag ?? '') || !/^[0-9a-f]{40}$/.test(commit ?? '')) {
    throw new Error('invalid release identity');
  }
  const prefix = `repos/${repository}`, expected = inventory(directory);
  const verifyTag = async () => {
    const ref = await api('GET', `${prefix}/git/ref/tags/${tag}`, undefined, true);
    if (!ref) throw new Error(`tag ${tag} is not on ${repository}; the mirror must carry it before publication`);
    let object = ref.object;
    for (let depth = 0; object.type === 'tag' && depth < 4; depth++) object = (await api('GET', `${prefix}/git/tags/${object.sha}`)).object;
    if (object.type !== 'commit' || object.sha !== commit) throw new Error(`${repository} tag ${tag} is not the built commit ${commit}`);
  };
  const checkAssets = async (release, complete) => {
    if (release.tag_name !== tag || !Number.isSafeInteger(release.id) || release.id < 1) throw new Error('release identity mismatch');
    const seen = new Map();
    for (let page = 1; ; page++) {
      const assets = await api('GET', `${prefix}/releases/${release.id}/assets?per_page=100&page=${page}`);
      if (!Array.isArray(assets)) throw new Error('invalid release asset inventory');
      for (const asset of assets) {
        const wanted = expected.get(asset.name);
        if (!wanted || seen.has(asset.name) || asset.state !== 'uploaded' || asset.size !== wanted.size || asset.digest !== wanted.digest) {
          throw new Error(`existing release asset differs from the verified inventory: ${asset.name}`);
        }
        seen.set(asset.name, asset.id);
      }
      if (assets.length < 100) break;
      if (page >= 20) throw new Error('release asset inventory exceeds supported bound');
    }
    if (complete && seen.size !== expected.size) throw new Error('release asset inventory is incomplete');
    return seen;
  };

  await verifyTag();
  let release = await api('GET', `${prefix}/releases/tags/${tag}`, undefined, true);
  if (release && !release.draft) {
    await checkAssets(release, true);
    log(`${repository} ${tag} is already published with exactly these ${expected.size} assets; nothing to do`);
    return release;
  }
  const existing = release ? await checkAssets(release, false) : new Map();
  const missing = [...expected].filter(([name]) => !existing.has(name));
  if (dryRun) {
    log(`dry run: ${repository} tag ${tag} -> ${commit} verified`);
    log(release ? `dry run: would resume draft release ${release.id}` : `dry run: would create draft release "Jankurai ${tag}"`);
    for (const [name, asset] of missing) log(`dry run: would upload ${name} (${asset.size} bytes, ${asset.digest})`);
    log(`dry run: would publish ${tag} (latest: ${latest}) after re-checking all ${expected.size} asset digests and the tag`);
    return null;
  }
  if (!release) {
    release = await api('POST', `${prefix}/releases`, { tag_name: tag, target_commitish: commit, name: `Jankurai ${tag}`,
      body: notes, draft: true, prerelease: false, make_latest: 'false' });
  }
  for (const [name, asset] of missing) { log(`uploading ${name}`); await upload(release, name, asset.file); }
  await checkAssets(release, true);
  await verifyTag();
  release = await api('PATCH', `${prefix}/releases/${release.id}`, { draft: false, prerelease: false, make_latest: latest ? 'true' : 'false' });
  const published = await api('GET', `${prefix}/releases/${release.id}`);
  if (published.draft !== false || published.tag_name !== tag) throw new Error('published release readback mismatch');
  await checkAssets(published, true);
  await verifyTag();
  log(`published ${published.html_url}`);
  return published;
}

export function readToken(file) {
  const info = fs.lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('token file must be a regular file, not a link');
  if ((info.mode & 0o077) !== 0) throw new Error('token file is readable by group/others; chmod 600 it');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('token file is not owned by the current user');
  const token = fs.readFileSync(file, 'utf8').trim();
  if (!token || /\s/.test(token)) throw new Error('token file must hold exactly one token');
  return token;
}

// readOnly clients refuse every write; a dry run may still authenticate its reads.
export function githubClient(token, { readOnly = false } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jankurai-release-publisher' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const api = async (method, endpoint, body, allowMissing = false) => {
    if (method !== 'GET' && (readOnly || !token)) throw new Error(`refusing GitHub ${method} ${readOnly ? 'in a dry run' : 'without a token'}`);
    const response = await fetch(`${API}/${endpoint}`, { method, headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${endpoint}: HTTP ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  };
  const upload = async (release, name, file) => {
    if (readOnly || !token) throw new Error('refusing a GitHub upload in a dry run or without a token');
    const response = await fetch(`${UPLOADS}/repos/${REPOSITORY}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(file) });
    if (!response.ok) throw new Error(`upload of ${name} failed: HTTP ${response.status}; verified draft assets are kept for a retry`);
  };
  return { api, upload };
}

function parse(args) {
  const options = { latest: true, dryRun: false, repository: REPOSITORY };
  for (let i = 0; i < args.length; i++) {
    const value = () => { if (!args[i + 1]) throw new Error(`missing value for ${args[i]}`); return args[++i]; };
    switch (args[i]) {
      case '--tag': options.tag = value(); break;
      case '--dist': options.directory = path.resolve(value()); break;
      case '--token-file': options.tokenFile = path.resolve(value()); break;
      case '--notes-file': options.notesFile = path.resolve(value()); break;
      case '--repo': options.repository = value(); break;
      case '--dry-run': options.dryRun = true; break;
      case '--no-latest': options.latest = false; break;
      default: throw new Error(`unknown argument: ${args[i]}`);
    }
  }
  if (!options.tag || !options.directory) throw new Error('usage: publish-github-release.sh --tag vX.Y.Z --dist <dir> (--token-file <file> | --dry-run) [--notes-file <file>] [--no-latest]');
  if (!options.dryRun && !options.tokenFile) throw new Error('--token-file is required unless --dry-run');
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parse(process.argv.slice(2));
    const tooling = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    // Never publish bytes that do not verify offline against the pinned key.
    const verified = spawnSync('bash', [path.join(tooling, 'ops/release/verify-release.sh'), '--dist', options.directory, '--tag', options.tag], { stdio: 'inherit' });
    if (verified.status !== 0) throw new Error('the inventory does not verify; refusing to publish');
    options.commit = releaseCommit(options.directory, options.tag);
    options.notes = fs.readFileSync(options.notesFile ?? path.join(tooling, 'docs/release-notes.md'), 'utf8');
    // A dry run authenticates only its reads (shared IPs exhaust anonymous limits).
    const token = options.tokenFile ? readToken(options.tokenFile) : null;
    const { api, upload } = githubClient(token, { readOnly: options.dryRun });
    await publish(options, api, upload);
  } catch (error) { console.error(`release publication: ${error.message}`); process.exitCode = 1; }
}
