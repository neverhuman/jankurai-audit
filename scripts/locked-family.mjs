// Prove the committed hub lock against freshly fetched forge objects. Bare
// object stores have no working copies; all evidence stays in the lane target/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import TOML from '@iarna/toml';
import { Family } from './family-model.mjs';
import { ObjectView, objectGit as git } from './family-object-view.mjs';
import { validateAuditorPin } from './auditor-pin.mjs';
import { validateVendoredTrust } from './vendored-trust.mjs';
import { validateTree } from './family-tree-validation.mjs';
import { pinOnMainProblem } from './pins-on-main.mjs';

export function lockedMembers(family) {
  return family.components().map(repo => {
    const pin = family.pins.get(repo.name);
    if (!pin) throw new Error(`${repo.name}: no family.lock pin`);
    return { name: repo.name, path: repo.path, url: repo.hosted, branch: repo.default_branch, tag: pin.tag, commit: pin.commit };
  });
}

// Fetch the real immutable tag, never manufacture a tag from the lock's claim.
export function composeMember(directory, { url, branch, tag, commit }) {
  if (fs.existsSync(directory)) throw new Error(`refusing to replace existing object evidence: ${directory}`);
  fs.mkdirSync(directory, { recursive: true });
  git(directory, ['init', '-q', '--bare']);
  git(directory, ['remote', 'add', 'origin', url]);
  git(directory, ['fetch', '-q', '--no-tags', 'origin',
    `refs/heads/${branch}:refs/remotes/origin/${branch}`, `refs/tags/${tag}:refs/tags/${tag}`]);
  const resolved = git(directory, ['rev-parse', `refs/tags/${tag}^{commit}`]);
  if (resolved !== commit) throw new Error(`immutable tag ${tag} resolves to ${resolved}, expected ${commit}`);
  return { directory, commit, main: git(directory, ['rev-parse', `refs/remotes/origin/${branch}`]) };
}

export function composeLockedFamily(hub, work) {
  if (fs.existsSync(work)) throw new Error(`refusing to replace existing evidence: ${work}`);
  fs.mkdirSync(work, { recursive: true });
  const head = git(hub, ['rev-parse', 'HEAD']);
  const io = new ObjectView();
  io.add(hub, hub, head);
  const family = Object.create(Family.prototype);
  Object.assign(family, { hub, root: path.dirname(hub),
    manifest: TOML.parse(io.readFileSync(path.join(hub, 'repos.manifest.toml'), 'utf8')),
    lock: TOML.parse(io.readFileSync(path.join(hub, 'family.lock'), 'utf8')) });
  family.repos = family.manifest.repo;
  family.pins = new Map(family.lock.repo.map(pin => [pin.repo, pin]));
  family.validate();
  family.existing = repo => io.trees.has(family.path(repo));
  const evidence = [];
  for (const member of lockedMembers(family)) {
    const fetched = composeMember(path.join(work, `${member.name}.git`), member);
    const problem = pinOnMainProblem(fetched.directory, member.commit);
    if (problem) throw new Error(`${member.name}: ${problem}`);
    io.add(path.join(family.root, member.path), fetched.directory, member.commit);
    evidence.push({ ...member, ...fetched });
  }
  return { head, family, io, evidence };
}

export function validateLockedFamily({ family, io }) {
  TOML.parse(io.readFileSync(path.join(family.hub, 'Cargo.lock'), 'utf8'));
  validateAuditorPin(family, { io });
  validateVendoredTrust(family, { io });
  for (const repo of family.repos) {
    const directory = family.path(repo);
    if (!family.existing(repo)) throw new Error(`missing component: ${repo.name}`);
    validateTree(directory, { io, tracked: io.tracked(directory) });
    for (const required of ['AGENTS.md', 'SPLIT.md', 'agent/owner-map.json', 'agent/test-map.json', 'agent/generated-zones.toml', 'scripts/ci-local.sh', 'ops/ci/required.sh']) {
      if (!io.existsSync(path.join(directory, required))) throw new Error(`${repo.name}: missing ${required}`);
    }
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hub = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  try {
    const parent = path.join(hub, 'target', 'locked-family');
    fs.mkdirSync(parent, { recursive: true });
    // Reserve a new evidence name without deleting any earlier checkout/report.
    const work = path.join(parent, `${Date.now()}-${process.pid}`);
    const result = composeLockedFamily(hub, work);
    validateLockedFamily(result);
    fs.writeFileSync(path.join(work, 'verified.json'), JSON.stringify({ hub: result.head, members: result.evidence }, null, 2) + '\n');
    console.log(`locked-family: immutable tags, main ancestry, metadata and trust verified for hub ${result.head}`);
  } catch (error) { console.error(`locked-family: ${error.message}`); process.exitCode = 1; }
}
