import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { REPO, qualifyPreTag, validateProbeAttestation } from './pre-tag-qualify.mjs';

const SOURCE = '0123456789abcdef0123456789abcdef01234567';
const CERT = 'https://github.com/neverhuman/jankurai-audit/.github/workflows/release-services.yml@refs/heads/main';
const PLATFORMS = { 'ubuntu-24.04': 'Linux/x86_64', 'macos-14': 'Darwin/arm64' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// These simulate the verifier protocol, not cryptographic qualification.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-tag-qualify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [platform, native] of Object.entries(PLATFORMS)) {
    const dir = path.join(root, `release-service-probe-${platform}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'probe.txt'), `Non-release signing probe\nsource=${SOURCE}\nplatform=${native}\n`);
    for (const suffix of ['sigstore.bundle', 'attestation.jsonl']) fs.writeFileSync(path.join(dir, `probe.txt.${suffix}`), '{}\n');
  }
  const run = { id: 123, repository: { full_name: 'neverhuman/jankurai-audit' }, head_repository: { full_name: 'neverhuman/jankurai-audit' },
    head_sha: SOURCE, head_branch: 'main', path: '.github/workflows/release-services.yml', event: 'workflow_dispatch',
    status: 'completed', conclusion: 'success', run_attempt: 2 };
  const jobs = Object.keys(PLATFORMS).map((platform, i) => ({ name: `verify (${platform})`, id: 10 + i,
    run_id: 123, run_attempt: 2, head_sha: SOURCE, status: 'completed', conclusion: 'success' }));
  const calls = [];
  const settings = { mutateAttestation: () => {}, envelope: results => results, fail: null };
  function execute(command, args, env) {
    calls.push({ command, args, env });
    if (args[0] === 'api') return JSON.stringify(args.at(-1).includes('/jobs?') ? { jobs, total_count: jobs.length } : run);
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.LD_PRELOAD, undefined);
    assert.ok(env.HOME.startsWith(os.tmpdir()));
    if (settings.fail === command) throw new Error('actual verifier refused');
    if (command === 'cosign') {
      assert.deepEqual(args.slice(0, 1), ['verify-blob']);
      assert.ok(args.includes(CERT));
      return '';
    }
    assert.deepEqual(args.slice(0, 2), ['attestation', 'verify']);
    for (const flag of ['--signer-digest', '--source-digest']) assert.equal(args[args.indexOf(flag) + 1], SOURCE);
    assert.equal(args[args.indexOf('--repo') + 1], 'neverhuman/jankurai-audit');
    assert.ok(args.includes('--deny-self-hosted-runners'));
    const result = { signature: { certificate: {
      subjectAlternativeName: CERT, issuer: 'https://token.actions.githubusercontent.com',
      buildSignerURI: CERT, buildSignerDigest: SOURCE,
      sourceRepositoryURI: 'https://github.com/neverhuman/jankurai-audit', sourceRepositoryDigest: SOURCE,
      sourceRepositoryRef: 'refs/heads/main', runnerEnvironment: 'github-hosted',
      runInvocationURI: 'https://github.com/neverhuman/jankurai-audit/actions/runs/123/attempts/2',
    } }, verifiedTimestamps: [{ type: 'Tlog' }], statement: { predicateType: 'https://slsa.dev/provenance/v1',
      subject: [{ digest: { sha256: hash(fs.readFileSync(args[2])) } }] } };
    settings.mutateAttestation(result);
    return JSON.stringify(settings.envelope([{ verificationResult: result }]));
  }
  return { root, run, jobs, calls, settings, execute,
    qualify: () => qualifyPreTag(root, { source: SOURCE, runId: 123, run: execute }) };
}

test('both exact probes require signature and attestation verification with anonymous isolated environments', t => {
  const f = fixture(t);
  const result = f.qualify();
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'signing-service-probes');
  assert.equal(result.probes.length, 2);
  assert.equal(f.calls.filter(call => call.command === 'cosign').length, 2);
  assert.equal(f.calls.filter(call => call.args[0] === 'attestation').length, 2);
  assert.equal(fs.existsSync(f.calls.at(-1).env.HOME), false);
});

for (const verifier of ['cosign', 'gh']) test(`a failed ${verifier} verification cannot be replaced by success text`, t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'result.txt'), 'Real anonymous signatures and attestations verified.');
  f.settings.fail = verifier;
  assert.throws(f.qualify, /verifier refused/);
});

for (const conclusion of ['failure', 'cancelled', 'skipped', null]) test(`refuse required platform result ${conclusion}`, t => {
  const f = fixture(t); f.jobs[1].conclusion = conclusion;
  assert.throws(f.qualify, /job identity or result/);
  assert.equal(f.calls.some(call => call.command === 'cosign'), false);
});

for (const [name, mutate] of Object.entries({
  empty: f => f.jobs.splice(0), missing: f => f.jobs.pop(), duplicate: f => f.jobs[1] = { ...f.jobs[0] },
  renamed: f => f.jobs[1].name = 'unexpected', stale: f => f.jobs[1].run_attempt--,
  wrongSource: f => f.run.head_sha = 'a'.repeat(40), wrongRepository: f => f.run.repository.full_name = 'counterfeit/repository',
  wrongWorkflow: f => f.run.path = '.github/workflows/release.yml', unfinished: f => f.run.status = 'in_progress',
  wrongRun: f => f.run.id++, wrongRef: f => f.run.head_branch = 'topic',
})) test(`refuse ${name} hosted evidence`, t => {
  const f = fixture(t); mutate(f); assert.throws(f.qualify, /release-services/);
});

for (const [field, value] of Object.entries({
  subjectAlternativeName: CERT.replace('release-services', 'release'),
  issuer: 'https://example.invalid', buildSignerURI: CERT.replace('release-services', 'release'),
  buildSignerDigest: 'a'.repeat(40), sourceRepositoryDigest: 'a'.repeat(40),
  sourceRepositoryURI: 'https://github.com/counterfeit/repository', sourceRepositoryRef: 'refs/tags/v1.8.0',
  runnerEnvironment: 'self-hosted', runInvocationURI: 'https://github.com/neverhuman/jankurai-audit/actions/runs/123/attempts/1',
})) test(`refuse mismatched verified certificate ${field}`, t => {
  const f = fixture(t); f.settings.mutateAttestation = result => result.signature.certificate[field] = value;
  assert.throws(f.qualify, /binding mismatch/);
});

test('refuse missing timestamps, wrong artifact and ambiguous attestations', t => {
  const f = fixture(t);
  f.settings.mutateAttestation = result => result.verifiedTimestamps = [];
  assert.throws(f.qualify, /binding mismatch/);
  f.settings.mutateAttestation = result => result.statement.subject[0].digest.sha256 = '0'.repeat(64);
  assert.throws(f.qualify, /binding mismatch/);
  f.settings.mutateAttestation = () => {};
  f.settings.envelope = results => [...results, ...results];
  assert.throws(f.qualify, /expected one verified/);
});

test('refuse missing platform, tampered source and symlink evidence before any verifier', t => {
  const f = fixture(t), dir = path.join(f.root, 'release-service-probe-macos-14');
  const asset = path.join(dir, 'probe.txt');
  fs.writeFileSync(asset, 'source=forged\n');
  assert.throws(f.qualify, /probe source or platform mismatch/);
  fs.unlinkSync(asset);
  fs.symlinkSync(path.join(f.root, 'release-service-probe-ubuntu-24.04/probe.txt'), asset);
  assert.throws(f.qualify, /ELOOP/);
  fs.unlinkSync(asset);
  fs.renameSync(dir, dir + '.retained');
  assert.throws(f.qualify, /ENOENT/);
  assert.equal(f.calls.length, 0);
});

test('an expected source and run must come from the caller, not evidence files', t => {
  const f = fixture(t);
  assert.throws(() => qualifyPreTag(f.root), /expected source SHA and run ID/);
  assert.throws(() => qualifyPreTag(f.root, { source: SOURCE, runId: 0 }), /expected source SHA and run ID/);
});

test('qualification is pinned to the renamed hub repository', () => {
  assert.equal(REPO, 'neverhuman/jankurai-audit');
});

// Retained output from actual GH2.100 verification, source fb97/run34487611925.
// It was signed before the hub was renamed, so its certificate names
// neverhuman/jankurai. This parser regression does not replace live signature
// verification, and that old identity can no longer qualify a tag.
test('parse the pinned GitHub CLI actual verified certificate representation', () => {
  const result = JSON.parse(fs.readFileSync(new URL('./fixtures/pretag-gh-2.100.0.json', import.meta.url), 'utf8'));
  const binding = { source: 'fb97e59686fb4c6e1f27b4d567adf8d7606bc881', runId: 34487611925, attempt: 1,
    artifactSha256: 'ffd51771fd6c328a7a73a829acd0a2cbc18ccd3e3c09fa04c4cf0fc53d61a798' };
  validateProbeAttestation(result, { ...binding, repo: 'neverhuman/jankurai' });
  assert.throws(() => validateProbeAttestation(result, binding), /binding mismatch/);
});
