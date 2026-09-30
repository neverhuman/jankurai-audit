import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, buildEnvironment, clean, git, gitText, run, temporaryCI } from './family-lib.mjs';
import { preserveCandidateDiagnostics } from './family-diagnostics.mjs';
import {
  beginPairedJournal, captureFileIdentity, captureSource, commitPairedReplace,
  identityMeta, operation, recordAfterImages, setJournalState, assertIdentity,
} from './family-operation.mjs';

export function api(endpoint, body, method) {
  const args = ['gh', 'api', endpoint];
  if (method) args.push('--method', method);
  if (body !== undefined) args.push('--input', '-');
  const output = run(args, { capture: true, input: body === undefined ? undefined : JSON.stringify(body) });
  return output ? JSON.parse(output) : undefined;
}
export function successful(repo, sha, request = api) {
  // GitHub API paths address the mirror; repo.slug is the forge identity.
  const checks = request(`repos/${repo.github_slug}/commits/${sha}/check-runs?filter=latest&per_page=100`).check_runs;
  return checks.some(check => check.name === repo.required_check && check.head_sha === sha &&
    check.status === 'completed' && check.conclusion === 'success' && check.app.slug === 'github-actions');
}
export function eligible(family, repo) {
  const directory = family.path(repo), branch = repo.default_branch;
  const env = buildEnvironment();
  git(directory, ['fetch', '--no-tags', repo.github, `refs/heads/${branch}:refs/remotes/origin/${branch}`], { env });
  git(directory, ['fetch', '--no-tags', repo.github, 'refs/tags/ci-*:refs/tags/ci-*'], { env });
  const tags = new Set(gitText(directory, 'tag', '--list', 'ci-*').split('\n'));
  for (const sha of gitText(directory, 'rev-list', `refs/remotes/origin/${branch}`).split('\n')) {
    if (tags.has(`ci-${sha}`) && gitText(directory, 'rev-parse', `refs/tags/ci-${sha}^{commit}`) === sha && successful(repo, sha)) return sha;
  }
  return family.pins.get(repo.name).commit;
}
export function lockText(original, pins) {
  return original.replace(/\[\[repo\]\][\s\S]*?(?=\[\[repo\]\]|$)/g, block => {
    const name = /^repo = "([^"]+)"$/m.exec(block)?.[1];
    if (!name) throw new Error('invalid lock block');
    const pin = pins.get(name);
    return block.replace(/^tag = "[^"]+"$/m, `tag = "${pin.tag}"`).replace(/^commit = "[^"]+"$/m, `commit = "${pin.commit}"`);
  });
}

function captureSources(family) {
  const components = {};
  for (const repo of family.components()) {
    if (!family.existing(repo)) continue;
    components[repo.name] = captureSource(family.path(repo));
  }
  return { hub: captureSource(family.hub), components };
}

function assertSources(family, expected) {
  const hub = captureSource(family.hub);
  if (hub.head !== expected.hub.head || hub.tree !== expected.hub.tree) {
    throw new Error('hub HEAD/tree changed while validating; accepted locks preserved');
  }
  for (const repo of family.components()) {
    if (!family.existing(repo)) continue;
    const current = captureSource(family.path(repo));
    const prior = expected.components[repo.name];
    if (!prior || current.head !== prior.head || current.tree !== prior.tree) {
      throw new Error(`${repo.name}: HEAD/tree changed while validating; accepted locks preserved`);
    }
  }
}

function updateWithTx(family, hooks, tx) {
  clean(family.hub);
  for (const repo of family.components()) if (family.existing(repo)) clean(family.path(repo));
  family.bootstrap();
  const source = captureSources(family);
  const beforeIdentities = Object.fromEntries(
    ['family.lock', 'Cargo.lock'].map(name => [name, captureFileIdentity(path.join(family.hub, name))]),
  );
  beginPairedJournal(tx, {
    source,
    locks: beforeIdentities,
  });
  const pins = new Map([...family.pins].map(([name, pin]) => [name, { ...pin }]));
  for (const repo of family.components()) {
    const sha = (hooks.eligible ?? eligible)(family, repo), directory = family.path(repo);
    if (git(directory, ['merge-base', '--is-ancestor', gitText(directory, 'rev-parse', 'HEAD'), sha], { check: false }).status !== 0) {
      throw new Error(`${repo.name}: candidate would leave divergent local work behind`);
    }
    if (sha !== pins.get(repo.name).commit) Object.assign(pins.get(repo.name), { commit: sha, tag: `ci-${sha}` });
  }
  const candidate = lockText(beforeIdentities['family.lock'].bytes.toString('utf8'), pins);
  if (candidate === beforeIdentities['family.lock'].bytes.toString('utf8')) {
    console.log('family pull: no newer successful revisions');
    setJournalState(tx, 'rolled-back');
    return;
  }
  setJournalState(tx, 'validating');
  temporaryCI(path.join(family.hub, 'target'), 'family-ci-', directory => {
    const cargo = (hooks.testCandidate ?? testCandidate)(family, directory, candidate);
    assertSources(family, source);
    for (const name of ['family.lock', 'Cargo.lock']) {
      assertIdentity(path.join(family.hub, name), beforeIdentities[name], name);
    }
    for (const repo of family.components()) clean(family.path(repo));
    assertSources(family, source);
    const afterBytes = { 'Cargo.lock': cargo, 'family.lock': candidate };
    recordAfterImages(tx, afterBytes);
    commitPairedReplace(tx, afterBytes, Object.fromEntries(
      Object.entries(beforeIdentities).map(([name, id]) => [name, identityMeta(id)]),
    ), { observe: hooks.observe });
  }, { onFailure: (directory, error) => preserveCandidateDiagnostics(directory, path.join(family.hub, 'target/family-diagnostics'), error) });
  console.log('family pull: validated candidate locks ready for a protected PR');
}

export function update(family, hooks = {}, tx) {
  if (!tx) return operation(family.hub, inner => updateWithTx(family, hooks, inner), { observe: hooks.observe });
  return updateWithTx(family, hooks, tx);
}

function testCandidate(family, directory, candidate) {
  atomicWrite(path.join(directory, 'candidate.lock'), candidate);
  // Strip credentials and Git rewrites before any candidate checkout/bootstrap.
  const script = fileURLToPath(new URL('./check-family-candidate.mjs', import.meta.url));
  run([process.execPath, script, family.hub, gitText(family.hub, 'rev-parse', 'HEAD'), directory], { env: buildEnvironment() });
  return fs.readFileSync(path.join(directory, 'jankurai/Cargo.lock'), 'utf8');
}
