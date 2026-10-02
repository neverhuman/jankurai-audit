import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readToml, exists, isLink, gitText, git, clean, atomicWrite, run, buildEnvironment } from './family-lib.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const GIT = '/usr/bin/git';
// Authority is the hosted jeryu forge; github.com is only a mirror of it.
const FORGE = 'jeryu';
const HOSTED_BASE = 'https://git.neverhuman.org';
const MIRROR_BASE = 'https://github.com';
// The hub mirrors as <prefix>; every other member as <prefix>-<suffix>.
// The git source members' Cargo.toml files depend on for a sibling crate.
const crateSource = (manifest, repo) => `${MIRROR_BASE}/${manifest.public_owner}/${repo.name}.git`;
const mirrorRepoName = (manifest, name) => (manifest.mirror_repo_override ?? {})[name]
  ?? `${manifest.mirror_repo_prefix}${name.slice(manifest.family.length)}`;
// Disk receipts cannot authorize a copy imported by a different process.
const isolateSeals = new Map();

export class Family {
  constructor(hub) {
    this.hub = fs.realpathSync(hub);
    this.root = path.dirname(this.hub);
    this.manifest = readToml(path.join(this.hub, 'repos.manifest.toml'));
    this.lock = readToml(path.join(this.hub, 'family.lock'));
    this.repos = this.manifest.repo;
    this.pins = new Map(this.lock.repo.map(pin => [pin.repo, pin]));
    this.fusion = path.join(this.hub, '.fusion');
    this.validate();
  }
  validate() {
    const m = this.manifest;
    // The hosted forge is the authority; GitHub is a mirror and may never claim it.
    if (m.authority_forge === 'github' || m.authority_forge === m.mirror_forge) throw new Error('GitHub is a mirror, not the family authority');
    if (m.schema_version !== '3.0.0' || m.authority_forge !== FORGE) throw new Error(`expected ${FORGE}-authority family schema 3.0.0`);
    if (m.hosted_base_url !== HOSTED_BASE || m.hosted_git_url_template !== `${HOSTED_BASE}/git/{owner}/{repo}.git`) throw new Error('hosted authority routes must name the forge');
    if (m.mirror_forge !== 'github' || m.mirror_base_url !== MIRROR_BASE || m.mirror_git_url_template !== `${MIRROR_BASE}/{owner}/{repo}.git`) throw new Error('mirror routes must name GitHub');
    const names = this.repos.map(repo => repo.name);
    if (new Set(names).size !== names.length || names.length !== m.expected_repo_count ||
        JSON.stringify([...names].sort()) !== JSON.stringify([...m.required_repos].sort())) throw new Error('duplicate or missing family repository');
    const components = names.filter(name => name !== 'jankurai').sort();
    if (this.pins.size !== this.lock.repo.length || JSON.stringify([...this.pins.keys()].sort()) !== JSON.stringify(components)) throw new Error('lock must pin each component exactly once');
    for (const repo of this.repos) this.validateRepo(repo);
    // Mirror-only repositories carry the same routes but no lock pin and no member metadata.
    for (const repo of this.manifest.mirror_only_repo ?? []) {
      if (names.includes(repo.name)) throw new Error(`${repo.name}: declared both as a member and mirror-only`);
      if (this.pins.has(repo.name)) throw new Error(`${repo.name}: mirror-only repositories take no lock pin`);
      this.validateRepo(repo);
    }
  }
  validateRepo(repo) {
    if (!/^jankurai(?:-[a-z]+)*$/.test(repo.name)) throw new Error('invalid repository name');
    const m = this.manifest;
    const slug = `${m.local_owner}/${repo.name}`;
    const mirrorSlug = `${m.public_owner}/${mirrorRepoName(m, repo.name)}`;
    if (repo.path !== repo.name || repo.slug !== slug || repo.jeryu_slug !== slug ||
        repo.hosted !== `${m.hosted_base_url}/git/${slug}.git`) throw new Error(`${repo.name}: expected relative canonical path and forge authority URL`);
    if (repo.github_slug !== mirrorSlug || repo.github !== `${m.mirror_base_url}/${mirrorSlug}.git`) throw new Error(`${repo.name}: expected the GitHub mirror URL`);
    if (repo.mirror_github !== true || repo.mirror_github_main !== true) throw new Error(`${repo.name}: the forge must mirror main to GitHub`);
    if ('legacy_jeryu' in repo) throw new Error(`${repo.name}: legacy_jeryu is retired`);
    if (repo.required_check !== `${repo.name}/required` || repo.default_branch !== 'main') throw new Error('invalid branch/check contract');
    if ('tag' in repo || 'commit' in repo) throw new Error('component revision pins belong only in family.lock');
    const pin = this.pins.get(repo.name);
    if (pin && (!/^[a-f0-9]{40}$/.test(pin.commit) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pin.tag))) throw new Error('malformed immutable pin');
  }
  components() { return this.repos.filter(repo => repo.name !== 'jankurai'); }
  path(repo) { return repo.name === 'jankurai' ? this.hub : path.join(this.root, repo.path); }
  existing(repo) {
    const directory = this.path(repo);
    if (!exists(directory) && !isLink(directory)) return false;
    const gd = path.join(directory, '.git');
    if (isLink(directory) || isLink(gd) || !exists(gd) || !fs.statSync(gd).isDirectory() ||
        gitText(directory, 'rev-parse', '--show-toplevel') !== directory) throw new Error(`${directory}: expected a canonical primary checkout`);
    return true;
  }
  // Where member checkouts and their pin tags come from. The forge is the
  // authority and the default. GitHub-hosted runners cannot read the private
  // forge, so ops/ci/github-setup.sh selects the public mirror. Every pin is
  // checked against its locked commit either way: the source decides
  // availability, never trust.
  pinSource(repo) {
    const source = process.env.JANKURAI_FAMILY_SOURCE || 'hosted';
    if (source === 'hosted') return repo.hosted;
    if (source === 'mirror') return repo.github;
    throw new Error('JANKURAI_FAMILY_SOURCE must be hosted or mirror');
  }
  // Members' Cargo git routes still name the pre-rename GitHub repositories,
  // some of which no longer serve Git. On a runner that resolves them from
  // GitHub, each is rewritten to its mirror. Revisions are still locked.
  legacyCrateRoutes() {
    const routes = [];
    for (const repo of this.components()) {
      const legacy = crateSource(this.manifest, repo);
      if (legacy === repo.github) continue;
      routes.push([legacy, repo.github], [legacy.replace('https://github.com/', 'https://www.github.com/'), repo.github]);
    }
    return routes;
  }
  fetchPin(repo) {
    const pin = this.pins.get(repo.name), directory = this.path(repo);
    git(directory, ['fetch', '--no-tags', this.pinSource(repo), `refs/tags/${pin.tag}:refs/tags/${pin.tag}`], { env: buildEnvironment() });
    if (gitText(directory, 'rev-parse', `refs/tags/${pin.tag}^{commit}`) !== pin.commit) throw new Error(`${repo.name}: immutable tag differs from lock`);
  }
  bootstrap(restore = false) {
    const existing = this.components().filter(repo => this.existing(repo));
    if (restore) for (const repo of existing) clean(this.path(repo));
    for (const repo of this.components()) {
      const directory = this.path(repo), pin = this.pins.get(repo.name);
      if (!exists(directory)) {
        run(['git', 'clone', '--no-checkout', '--origin', 'origin', this.pinSource(repo), directory], { env: buildEnvironment() });
        this.fetchPin(repo);
        git(directory, ['checkout', '--detach', pin.commit]);
      } else if (restore) this.fetchPin(repo);
    }
    if (restore) this.restore(existing);
  }
  restore(repos) {
    for (const repo of repos) {
      const directory = this.path(repo), pin = this.pins.get(repo.name), head = gitText(directory, 'rev-parse', 'HEAD');
      if (head !== pin.commit && git(directory, ['merge-base', '--is-ancestor', head, pin.commit], { check: false }).status !== 0) throw new Error(`${repo.name}: restoring lock would discard ahead/divergent commits`);
    }
    for (const repo of repos) {
      const directory = this.path(repo), pin = this.pins.get(repo.name);
      clean(directory);
      if (gitText(directory, 'rev-parse', 'HEAD') !== pin.commit) git(directory, ['checkout', '--detach', pin.commit]);
    }
  }
  fuse(copyLock = true, isolate = false) {
    const links = this.ownedComponentRoot(isolate), members = [], patches = new Map();
    for (const repo of this.components()) {
      const directory = this.path(repo), link = path.join(links, repo.name);
      if (!this.existing(repo)) throw new Error(`missing component: ${repo.name}`);
      if (isolate) this.materializeIsolate(directory, link);
      else if (isLink(link)) {
        if (fs.realpathSync(link) !== directory) throw new Error(`refusing mismatched link: ${link}`);
      } else if (exists(link) && isolateMarker(link)) {
        assertExactOwnedIsolate(link, links, directory, this.fusion);
        removeOwned(link, links, this.fusion);
        fs.symlinkSync(path.relative(links, directory), link, 'dir');
      } else if (exists(link)) throw new Error(`refusing to overwrite directory: ${link}`);
      else fs.symlinkSync(path.relative(links, directory), link, 'dir');
      if (!exists(path.join(directory, 'Cargo.toml'))) continue;
      for (const member of readToml(path.join(directory, 'Cargo.toml')).workspace.members) {
        const relative = `components/${repo.name}/${member}`;
        const name = readToml(path.join(directory, member, 'Cargo.toml')).package.name;
        members.push(relative);
        // Members' Cargo git routes still name the pre-rename repositories
        // (github.com/<public_owner>/<repo>.git, see docs/forge-authority.md),
        // so the fusion patches that source, not the mirror URL.
        const source = crateSource(this.manifest, repo);
        if (!patches.has(source)) patches.set(source, []);
        patches.get(source).push([name, relative]);
      }
    }
    let cargo = `[workspace]\nresolver = "2"\nmembers = ${JSON.stringify(members, null, 2)}\n`;
    for (const [url, entries] of patches) {
      cargo += `\n[patch.${JSON.stringify(url)}]\n`;
      for (const [name, relative] of entries) cargo += `${name} = { path = ${JSON.stringify(relative)} }\n`;
    }
    atomicWrite(path.join(this.fusion, 'Cargo.toml'), cargo);
    if (copyLock) fs.copyFileSync(path.join(this.hub, 'Cargo.lock'), path.join(this.fusion, 'Cargo.lock'));
    atomicWrite(path.join(this.fusion, 'dev.sh'), '#!/usr/bin/env bash\nset -euo pipefail\nexec bash "$(dirname "${BASH_SOURCE[0]}")/../scripts/family.sh" "${@:-build}"\n');
    fs.chmodSync(path.join(this.fusion, 'dev.sh'), 0o755);
  }
  ownedComponentRoot(isolate) {
    if (isLink(this.fusion)) throw new Error('refusing symlinked .fusion');
    fs.mkdirSync(this.fusion, { recursive: true });
    if (isLink(this.fusion)) throw new Error('refusing symlinked .fusion');
    const links = path.join(this.fusion, 'components');
    if (isLink(links)) throw new Error('refusing symlinked .fusion/components');
    fs.mkdirSync(links, { recursive: true });
    if (isLink(links)) throw new Error('refusing symlinked .fusion/components');
    if (isolate && fs.realpathSync(links) !== links) throw new Error('refusing redirected .fusion/components');
    return links;
  }
  ownedRequiredRoot() {
    if (isLink(this.fusion)) throw new Error('refusing symlinked .fusion');
    const required = path.join(this.fusion, 'required-components');
    if (isLink(required)) throw new Error('refusing symlinked .fusion/required-components');
    fs.mkdirSync(required, { recursive: true });
    if (isLink(required) || fs.realpathSync(required) !== required) throw new Error('refusing redirected .fusion/required-components');
    return required;
  }
  acceptedSourceRevision(directory) {
    const resolved = fs.realpathSync(directory);
    const commit = isolateGitText(directory, 'rev-parse', 'HEAD');
    const tree = isolateGitText(directory, 'rev-parse', `${commit}^{tree}`);
    if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree)) throw new Error('unfrozen isolate revision');
    for (const repo of this.components()) {
      const candidate = this.path(repo);
      const same = path.resolve(candidate) === path.resolve(directory)
        || (exists(candidate) && fs.realpathSync(candidate) === resolved);
      if (!same) continue;
      const pin = this.pins.get(repo.name);
      if (pin && pin.commit !== commit) throw new Error(`${repo.name}: isolate source is not the accepted revision`);
      return { repo, commit, tree, pin };
    }
    return { commit, tree, pin: null };
  }
  materializeIsolate(directory, dest) {
    const parent = path.dirname(dest);
    if (isLink(parent) || fs.realpathSync(parent) !== parent) throw new Error(`refusing redirected isolate parent: ${parent}`);
    if (isLink(dest)) {
      if (fs.realpathSync(dest) !== directory) throw new Error(`refusing to replace symlink: ${dest}`);
      fs.unlinkSync(dest);
    }
    const { commit, tree } = this.acceptedSourceRevision(directory);
    const entries = listCommittedTree(directory, commit);
    for (const entry of entries) {
      if (entry.mode === '120000') entry.target = gitBlob(directory, entry.hash).toString();
    }
    preflightCommittedLinks(entries);
    if (exists(dest) && !isolateMarker(dest)) throw new Error(`refusing to overwrite directory: ${dest}`);
    if (exists(dest)) {
      assertExactOwnedIsolate(dest, parent, directory, this.fusion);
      removeOwned(dest, parent, this.fusion);
    }
    const staging = fs.mkdtempSync(path.join(parent, '.isolate-staging-'));
    try {
      exportCommittedTree(staging, directory, entries);
      if (isolateGitText(directory, 'rev-parse', 'HEAD') !== commit) {
        throw new Error('isolate source changed during materialization');
      }
      if (isolateGitText(directory, 'rev-parse', `${commit}^{tree}`) !== tree) {
        throw new Error('isolate source tree changed during materialization');
      }
      const files = isolateInventory(staging);
      assertCommittedInventory(directory, commit, files);
      fs.renameSync(staging, dest);
      const record = { kind: 'owned-execution-copy', source: path.resolve(directory), commit, tree, files };
      writeIsolateMarker(dest, record);
      writeComponentGitIdentity(dest, directory, commit);
      writeIsolateAuthority(this.fusion, dest, record);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
  rematerializeIsolates() {
    const required = this.ownedRequiredRoot();
    for (const repo of this.components()) {
      if (!this.existing(repo)) throw new Error(`missing component: ${repo.name}`);
      this.materializeIsolate(this.path(repo), path.join(required, repo.name));
    }
  }
  disposeIsolates() {
    for (const rootName of ['components', 'required-components']) {
      const links = path.join(this.fusion, rootName);
      if (!exists(links) || isLink(links)) continue;
      for (const repo of this.components()) {
        const dest = path.join(links, repo.name);
        if (!exists(dest) || !isolateMarker(dest)) continue;
        try { assertExactOwnedIsolate(dest, links, this.path(repo), this.fusion); }
        catch { continue; }
        removeOwned(dest, links, this.fusion);
      }
    }
  }
  executionPath(repo) {
    const live = this.path(repo);
    const pin = this.pins.get(repo.name);
    const head = isolateGitText(live, 'rev-parse', 'HEAD');
    if (pin && pin.commit !== head) throw new Error(`${repo.name}: isolate source is not the accepted revision`);
    for (const rootName of ['required-components', 'components']) {
      const links = path.join(this.fusion, rootName);
      const isolated = path.join(links, repo.name);
      if (!exists(isolated) || !isolateMarker(isolated)) continue;
      if (isLink(links)) throw new Error(`refusing redirected isolate root: ${links}`);
      assertExactOwnedIsolate(isolated, links, live, this.fusion);
      const record = readIsolateMarker(isolated);
      if (record.commit !== head || (pin && record.commit !== pin.commit)) {
        throw new Error(`${repo.name}: isolate copy is not the accepted revision`);
      }
      return isolated;
    }
    if (this.allowLiveRequired) return live;
    throw new Error(`missing isolated execution copy: ${repo.name}`);
  }
  status() {
    for (const repo of this.repos) {
      if (!this.existing(repo)) { console.log(`${repo.name}: missing`); continue; }
      const directory = this.path(repo), head = gitText(directory, 'rev-parse', 'HEAD');
      const branch = gitText(directory, 'branch', '--show-current') || 'detached', pin = this.pins.get(repo.name);
      console.log(`${repo.name}: ${branch} ${head.slice(0, 12)} (${!pin ? 'hub' : head === pin.commit ? 'locked' : `differs from lock ${pin.commit.slice(0, 12)}`})`);
      const dirty = gitText(directory, 'status', '--short');
      if (dirty) console.log(dirty);
    }
  }
}

function isolateGitEnv() {
  return {
    PATH: '/usr/bin:/bin',
    HOME: os.tmpdir(),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
  };
}

function isolateGitText(directory, ...args) {
  const result = spawnSync(GIT, ['-C', directory, ...args], {
    encoding: 'utf8', env: isolateGitEnv(), maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error((result.stderr || `git ${args.join(' ')}`).toString().trim());
  return result.stdout.trim();
}

function isolateMarkPath(directory) {
  return `${directory}.jankurai-isolate`;
}

function isolateGitDir(directory) {
  return `${directory}.gitdir`;
}

function isolateAuthorityPath(fusion, dest) {
  return path.join(fusion, '.isolate-owned', digest(path.resolve(dest)));
}

function isolateMarker(directory) {
  return exists(isolateMarkPath(directory)) && !isLink(isolateMarkPath(directory));
}

function readIsolateMarker(directory) {
  const mark = isolateMarkPath(directory);
  if (isLink(mark)) throw new Error(`refusing symlinked isolate marker: ${mark}`);
  const record = JSON.parse(fs.readFileSync(mark, 'utf8'));
  if (record?.kind !== 'owned-execution-copy' || !Array.isArray(record.files)) {
    throw new Error(`invalid isolate ownership record: ${mark}`);
  }
  return record;
}

function writeIsolateMarker(directory, record) {
  const mark = isolateMarkPath(directory);
  if (exists(mark) || isLink(mark)) throw new Error(`refusing to replace isolate marker: ${mark}`);
  const fd = fs.openSync(mark, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
  try {
    fs.writeFileSync(fd, JSON.stringify(record) + '\n');
  } finally {
    fs.closeSync(fd);
  }
}

function writeIsolateAuthority(fusion, dest, record) {
  if (isLink(fusion)) throw new Error(`refusing symlinked isolate fusion: ${fusion}`);
  const directory = path.join(fusion, '.isolate-owned');
  if (isLink(directory)) throw new Error(`refusing symlinked isolate authority: ${directory}`);
  fs.mkdirSync(directory, { recursive: true });
  if (isLink(directory)) throw new Error(`refusing symlinked isolate authority: ${directory}`);
  const destStat = fs.lstatSync(dest);
  const markStat = fs.lstatSync(isolateMarkPath(dest));
  if (destStat.isSymbolicLink() || markStat.isSymbolicLink()) throw new Error('refusing symlinked isolate authority inputs');
  const file = isolateAuthorityPath(fusion, dest);
  if (exists(file) || isLink(file)) throw new Error(`refusing to replace isolate authority: ${file}`);
  const payload = {
    kind: 'owned-execution-copy',
    dest: path.resolve(dest),
    destDev: destStat.dev,
    destIno: destStat.ino,
    markDev: markStat.dev,
    markIno: markStat.ino,
    source: record.source,
    commit: record.commit,
    tree: record.tree,
    files: record.files,
  };
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
  try {
    fs.writeFileSync(fd, JSON.stringify(payload) + '\n');
  } finally {
    fs.closeSync(fd);
  }
  // Keep an immutable private digest; readable JSON is a receipt, not authority.
  isolateSeals.set(file, sealIsolateMetadata(fusion, dest));
}

function readIsolateAuthority(fusion, dest) {
  verifyIsolateSeal(fusion, dest);
  const file = isolateAuthorityPath(fusion, dest);
  if (!exists(file) || isLink(file)) throw new Error(`missing coordinator isolate authority: ${dest}`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (record?.kind !== 'owned-execution-copy' || !/^[a-f0-9]{40}$/.test(record.commit || '') || !/^[a-f0-9]{40}$/.test(record.tree || '')) {
    throw new Error(`invalid coordinator isolate authority: ${dest}`);
  }
  return record;
}

function writeComponentGitIdentity(dest, source, commit) {
  const sourceGit = isolateGitText(source, 'rev-parse', '--absolute-git-dir');
  if (isLink(sourceGit) || isLink(path.join(source, '.git'))) throw new Error('refusing symlinked git dir');
  const gitDir = isolateGitDir(dest);
  if (exists(gitDir) || isLink(gitDir)) throw new Error(`refusing to replace isolate gitdir: ${gitDir}`);
  fs.mkdirSync(gitDir);
  fs.mkdirSync(path.join(gitDir, 'objects', 'info'), { recursive: true });
  fs.mkdirSync(path.join(gitDir, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), `${commit}\n`);
  fs.writeFileSync(path.join(gitDir, 'objects', 'info', 'alternates'), `${path.join(sourceGit, 'objects')}\n`);
  fs.writeFileSync(path.join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n');
  const gitFile = path.join(dest, '.git');
  if (exists(gitFile) || isLink(gitFile)) throw new Error(`refusing to replace isolate gitfile: ${gitFile}`);
  const fd = fs.openSync(gitFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
  try {
    fs.writeFileSync(fd, `gitdir: ${path.resolve(gitDir)}\n`);
  } finally {
    fs.closeSync(fd);
  }
  // Populate the accepted index without a checkout or any content filters.
  for (const args of [['read-tree', commit], ['update-index', '--refresh']]) {
    const result = spawnSync(GIT, [`--git-dir=${gitDir}`, `--work-tree=${dest}`, ...args], {
      encoding: 'utf8', env: isolateGitEnv(), maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error(`isolate Git index failed: ${result.error?.message || result.stderr}`);
  }
}

function containedLexical(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function resolveVirtualLink(startRel, target, links) {
  if (path.isAbsolute(target)) throw new Error(`archive link escaped isolate: ${startRel}`);
  const seen = new Set([startRel]);
  const walk = (fromParts, raw, hops) => {
    if (hops > 32) throw new Error(`archive link chain too long: ${startRel}`);
    if (path.isAbsolute(raw)) throw new Error(`archive link escaped isolate: ${startRel}`);
    const parts = [...fromParts];
    for (const segment of raw.split(/[\\/]/)) {
      if (!segment || segment === '.') continue;
      if (segment === '..') {
        if (parts.length === 0) throw new Error(`archive link escaped isolate: ${startRel}`);
        parts.pop();
        continue;
      }
      parts.push(segment);
      const rel = parts.join('/');
      if (!links.has(rel)) continue;
      if (seen.has(rel)) throw new Error(`archive link cycle: ${startRel}`);
      seen.add(rel);
      const resolved = walk(parts.slice(0, -1), links.get(rel), hops + 1);
      parts.length = 0;
      if (resolved) parts.push(...resolved.split('/').filter(Boolean));
    }
    return parts.join('/');
  };
  const dir = startRel.includes('/') ? startRel.split('/').slice(0, -1) : [];
  walk(dir, target, 0);
}

function preflightCommittedLinks(entries) {
  const links = new Map();
  for (const entry of entries) {
    if (entry.mode !== '120000') continue;
    if (path.isAbsolute(entry.target) || entry.target.includes('\0')) {
      throw new Error(`archive link escaped isolate: ${entry.name}`);
    }
    links.set(entry.name, entry.target);
  }
  for (const [name, target] of links) resolveVirtualLink(name, target, links);
}

function resolveLinkChain(dest, startRel, target) {
  if (path.isAbsolute(target)) throw new Error(`archive link escaped isolate: ${startRel}`);
  const seen = new Set([startRel]);
  const walk = (from, raw, hops) => {
    if (hops > 32) throw new Error(`archive link chain too long: ${startRel}`);
    if (path.isAbsolute(raw)) throw new Error(`archive link escaped isolate: ${startRel}`);
    let current = from;
    for (const segment of raw.split(/[\\/]/)) {
      if (!segment || segment === '.') continue;
      if (segment === '..') {
        const parent = path.dirname(current);
        if (!containedLexical(dest, parent) && path.resolve(parent) !== path.resolve(dest)) {
          throw new Error(`archive link escaped isolate: ${startRel}`);
        }
        current = parent;
        continue;
      }
      current = path.join(current, segment);
      if (!containedLexical(dest, current)) throw new Error(`archive link escaped isolate: ${startRel}`);
      try {
        const stat = fs.lstatSync(current);
        if (!stat.isSymbolicLink()) continue;
        const rel = path.relative(dest, current);
        if (seen.has(rel)) throw new Error(`archive link cycle: ${startRel}`);
        seen.add(rel);
        current = walk(path.dirname(current), fs.readlinkSync(current), hops + 1);
      } catch (error) {
        if (error.message.startsWith('archive link')) throw error;
      }
    }
    if (!containedLexical(dest, current)) throw new Error(`archive link escaped isolate: ${startRel}`);
    return current;
  };
  return walk(path.join(dest, path.dirname(startRel)), target, 0);
}

function mkdirLexical(root, rel) {
  if (!rel || rel === '.') return;
  let current = root;
  for (const segment of rel.split(/[\\/]/)) {
    if (!segment || segment === '.') continue;
    if (segment === '..') throw new Error('archive path escaped isolate');
    current = path.join(current, segment);
    if (!containedLexical(root, current)) throw new Error('archive path escaped isolate');
    if (isLink(current)) throw new Error(`refusing to write through symlink: ${current}`);
    if (!exists(current)) fs.mkdirSync(current);
    else if (!fs.lstatSync(current).isDirectory()) throw new Error(`refusing non-directory parent: ${current}`);
  }
}

function listCommittedTree(directory, commit) {
  const gitDir = isolateGitText(directory, 'rev-parse', '--absolute-git-dir');
  if (isLink(gitDir) || isLink(path.join(directory, '.git'))) throw new Error('refusing symlinked git dir');
  const result = spawnSync(GIT, [`--git-dir=${gitDir}`, 'ls-tree', '-r', '-z', commit], {
    encoding: 'buffer', env: isolateGitEnv(), maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error((result.stderr || 'ls-tree failed').toString().trim());
  return result.stdout.toString('utf8').split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t');
    const [mode, type, hash] = line.slice(0, tab).split(' ');
    return { mode, type, hash, name: line.slice(tab + 1) };
  });
}

function exportCommittedTree(dest, directory, entries) {
  if (isLink(dest) || !fs.lstatSync(dest).isDirectory()) throw new Error(`refusing isolate dest: ${dest}`);
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name.split('/').includes('.git')) {
      throw new Error(`refusing to import git metadata: ${entry.name}`);
    }
    const full = path.join(dest, entry.name);
    if (!containedLexical(dest, full)) throw new Error(`archive path escaped isolate: ${entry.name}`);
    mkdirLexical(dest, path.posix.dirname(entry.name));
    if (entry.mode === '120000') {
      fs.symlinkSync(entry.target, full);
    } else if (entry.mode === '100644' || entry.mode === '100755') {
      const mode = entry.mode === '100755' ? 0o755 : 0o644;
      const bytes = gitBlob(directory, entry.hash);
      const fd = fs.openSync(full, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, mode);
      try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
    } else throw new Error(`unsupported committed mode: ${entry.mode}`);
  }
}

function isolateInventory(dest) {
  if (isLink(dest)) throw new Error(`refusing symlinked isolate copy: ${dest}`);
  const files = [];
  const walk = rel => {
    if (rel === '.git') return;
    const full = rel ? path.join(dest, rel) : dest;
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(full);
      resolveLinkChain(dest, rel, target);
      files.push({ name: rel, type: 'link', mode: stat.mode & 0o777, sha256: null, target });
      return;
    }
    if (stat.isDirectory()) {
      if (rel) files.push({ name: rel, type: 'dir', mode: stat.mode & 0o777, sha256: null, target: null });
      for (const child of fs.readdirSync(full).sort()) walk(rel ? path.join(rel, child) : child);
      return;
    }
    if (!stat.isFile() || !rel) throw new Error(`unsupported isolate entry: ${rel || dest}`);
    const bytes = fs.readFileSync(full);
    files.push({ name: rel, type: 'file', mode: stat.mode & 0o777, sha256: digest(bytes), target: null, size: bytes.length });
  };
  walk('');
  return files;
}

function gitBlob(directory, hash) {
  const gitDir = isolateGitText(directory, 'rev-parse', '--absolute-git-dir');
  if (isLink(gitDir)) throw new Error('refusing symlinked git dir');
  const result = spawnSync(GIT, [`--git-dir=${gitDir}`, 'cat-file', 'blob', hash], {
    encoding: 'buffer', env: isolateGitEnv(), maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`missing committed blob ${hash}`);
  return result.stdout;
}

function assertCommittedInventory(directory, commit, files) {
  const listed = listCommittedTree(directory, commit);
  const leaf = files.filter(file => file.type !== 'dir');
  if (listed.length !== leaf.length) throw new Error('isolate inventory does not match the frozen commit tree');
  const byName = new Map(leaf.map(file => [file.name, file]));
  for (const entry of listed) {
    const file = byName.get(entry.name);
    if (!file) throw new Error(`isolate missing committed path: ${entry.name}`);
    const blob = gitBlob(directory, entry.hash);
    if (entry.mode === '120000') {
      if (file.type !== 'link' || file.target !== blob.toString()) throw new Error(`isolate link mismatch: ${entry.name}`);
    } else if (entry.mode === '100644' || entry.mode === '100755') {
      if (file.type !== 'file' || file.sha256 !== digest(blob)) throw new Error(`isolate blob mismatch: ${entry.name}`);
    } else throw new Error(`unsupported committed mode: ${entry.mode}`);
  }
}

function assertExactOwnedIsolate(dest, links, source, fusion) {
  if (isLink(dest) || isLink(links)) throw new Error(`refusing redirected isolate path: ${dest}`);
  const realDest = fs.realpathSync(dest);
  const realLinks = fs.realpathSync(links);
  if (realDest === realLinks || !realDest.startsWith(realLinks + path.sep)) {
    throw new Error(`isolate copy escaped owned root: ${dest}`);
  }
  if (source && realDest === fs.realpathSync(source)) throw new Error(`isolate copy resolved to live source: ${dest}`);
  const record = readIsolateMarker(dest);
  const authority = readIsolateAuthority(fusion, dest);
  const destStat = fs.lstatSync(dest);
  const markStat = fs.lstatSync(isolateMarkPath(dest));
  if (authority.destDev !== destStat.dev || authority.destIno !== destStat.ino) {
    throw new Error(`isolate root is not coordinator-owned: ${dest}`);
  }
  if (authority.markDev !== markStat.dev || authority.markIno !== markStat.ino) {
    throw new Error(`isolate marker is not coordinator-owned: ${dest}`);
  }
  if (path.resolve(authority.dest) !== path.resolve(dest) || authority.commit !== record.commit || authority.tree !== record.tree) {
    throw new Error(`isolate authority does not match marker: ${dest}`);
  }
  if (!/^[a-f0-9]{40}$/.test(record.commit || '') || !/^[a-f0-9]{40}$/.test(record.tree || '') || !Array.isArray(record.files)) {
    throw new Error(`incomplete isolate ownership record: ${dest}`);
  }
  if (!record.files.every(file => file && typeof file.name === 'string' && ['file', 'link', 'dir'].includes(file.type)
      && Number.isInteger(file.mode)
      && (file.type === 'file' ? /^[a-f0-9]{64}$/.test(file.sha256) : file.sha256 == null)
      && (file.type === 'link' ? typeof file.target === 'string' : file.target == null))) {
    throw new Error(`isolate record lacks exact identity: ${dest}`);
  }
  if (source && fs.realpathSync(record.source) !== fs.realpathSync(source)) {
    throw new Error(`isolate source identity mismatch: ${dest}`);
  }
  if (source) {
    const head = isolateGitText(source, 'rev-parse', 'HEAD');
    const tree = isolateGitText(source, 'rev-parse', `${head}^{tree}`);
    if (record.commit !== head || record.tree !== tree || authority.commit !== head) {
      throw new Error(`isolate source is not the accepted revision: ${dest}`);
    }
  }
  const actual = isolateInventory(dest);
  if (actual.length !== record.files.length) throw new Error(`preserving changed isolate inventory: ${dest}`);
  for (let i = 0; i < actual.length; i++) {
    const got = actual[i], want = record.files[i];
    if (got.name !== want.name || got.type !== want.type || got.mode !== want.mode
        || got.sha256 !== want.sha256 || got.target !== want.target) {
      throw new Error(`preserving changed isolate material: ${got.name || dest}`);
    }
  }
}

function removeOwned(dest, links, fusion) {
  verifyIsolateSeal(fusion, dest);
  if (isLink(dest)) throw new Error(`refusing to delete symlink: ${dest}`);
  if (!exists(dest)) return;
  const realDest = fs.realpathSync(dest);
  const realLinks = fs.realpathSync(links);
  if (realDest !== realLinks && !realDest.startsWith(realLinks + path.sep)) {
    throw new Error(`refusing to delete outside owned isolate root: ${dest}`);
  }
  fs.rmSync(dest, { recursive: true, force: false });
  const mark = isolateMarkPath(dest);
  if (exists(mark) && !isLink(mark)) fs.unlinkSync(mark);
  const gitDir = isolateGitDir(dest);
  if (exists(gitDir) && !isLink(gitDir)) fs.rmSync(gitDir, { recursive: true, force: false });
  const authority = isolateAuthorityPath(fusion, dest);
  if (exists(authority) && !isLink(authority)) fs.unlinkSync(authority);
  isolateSeals.delete(authority);
}

// Bound regular metadata reads and refuse links/special files before cleanup.
// This is process ownership, not durable recovery or a same-UID sandbox.
function sealIsolateMetadata(fusion, dest) {
  const entries = [];
  let budget = 64 * 1024 * 1024;
  let count = 0;
  function directoryIdentity(directory) {
    let cursor = path.parse(path.resolve(directory)).root;
    for (const part of path.resolve(directory).slice(cursor.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      const info = fs.lstatSync(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`redirected isolate metadata directory: ${cursor}`);
    }
    const info = fs.lstatSync(directory);
    entries.push([directory, 'root', info.dev, info.ino, info.mode & 0o777]);
  }
  function visit(file) {
    if (++count > 100000) throw new Error('isolate metadata entry limit exceeded');
    const info = fs.lstatSync(file);
    if (info.isSymbolicLink()) throw new Error(`changed isolate metadata link preserved: ${file}`);
    if (info.isDirectory()) {
      entries.push([file, 'dir', info.dev, info.ino, info.mode & 0o777]);
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
      return;
    }
    if (!info.isFile() || info.size > budget) throw new Error(`unsupported or oversized isolate metadata preserved: ${file}`);
    budget -= info.size;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new Error('isolate metadata changed while opening');
      const hash = createHash('sha256'), buffer = Buffer.alloc(65536);
      let total = 0, read;
      while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) {
        total += read;
        if (total > info.size) throw new Error('isolate metadata grew while reading');
        hash.update(buffer.subarray(0, read));
      }
      if (total !== info.size) throw new Error('isolate metadata changed while reading');
      entries.push([file, 'file', info.dev, info.ino, info.mode & 0o777, hash.digest('hex')]);
    } finally { fs.closeSync(fd); }
  }
  directoryIdentity(fusion);
  directoryIdentity(path.dirname(dest));
  directoryIdentity(dest);
  directoryIdentity(path.join(fusion, '.isolate-owned'));
  visit(isolateMarkPath(dest));
  visit(isolateAuthorityPath(fusion, dest));
  visit(path.join(dest, '.git'));
  visit(isolateGitDir(dest));
  return digest(JSON.stringify(entries));
}

function verifyIsolateSeal(fusion, dest) {
  const expected = isolateSeals.get(isolateAuthorityPath(fusion, dest));
  if (!expected) throw new Error(`missing process-owned isolate authority: ${dest}`);
  if (sealIsolateMetadata(fusion, dest) !== expected) throw new Error(`changed isolate authority or Git metadata preserved: ${dest}`);
}
