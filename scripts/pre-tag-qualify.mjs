#!/usr/bin/env node
// Re-verify signing probes. Recorded messages and repository files grant no trust.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SUCCESS_MARKER =
  'Real anonymous signatures and attestations verified; modified content and wrong repository/workflow/source/tag rejected.';
// The hub was renamed from neverhuman/jankurai after v1.7.1. Probes are signed per
// candidate commit, so only the current repository identity can qualify a tag.
export const REPO = 'neverhuman/jankurai-audit';
const WORKFLOW = '.github/workflows/release-services.yml';
const REF = 'refs/heads/main';
const identityOf = repo => `https://github.com/${repo}/${WORKFLOW}@${REF}`;
const IDENTITY = identityOf(REPO);
const ISSUER = 'https://token.actions.githubusercontent.com';
const PLATFORMS = { 'ubuntu-24.04': 'Linux/x86_64', 'macos-14': 'Darwin/arm64' };
const FILES = ['probe.txt', 'probe.txt.sigstore.bundle', 'probe.txt.attestation.jsonl'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function readEvidence(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size < 1 || st.size > 4 * 1024 * 1024) throw new Error(`invalid evidence file: ${file}`);
    const buffer = Buffer.alloc(st.size + 1);
    let used = 0, count;
    while (used < buffer.length && (count = fs.readSync(fd, buffer, used, buffer.length - used, null)) > 0) used += count;
    if (used !== st.size) throw new Error(`evidence changed size: ${file}`);
    return buffer.subarray(0, used);
  } finally { fs.closeSync(fd); }
}

function directory(file) {
  if (!fs.lstatSync(file).isDirectory()) throw new Error(`evidence directory required: ${file}`);
}

export function validateProbeRun(run, jobs, { source, runId }) {
  if (run.id !== Number(runId) || run.repository?.full_name !== REPO || run.head_repository?.full_name !== REPO ||
      run.head_sha !== source || run.head_branch !== 'main' || run.path !== WORKFLOW ||
      !['push', 'workflow_dispatch'].includes(run.event) || run.status !== 'completed' || run.conclusion !== 'success' ||
      !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) throw new Error('release-services run identity or result mismatch');
  const names = Object.keys(PLATFORMS).map(platform => `verify (${platform})`);
  const ids = new Set();
  if (!Array.isArray(jobs) || jobs.length !== names.length) throw new Error('release-services requires both exact platform jobs');
  for (const job of jobs) {
    if (!names.includes(job.name) || jobs.filter(other => other.name === job.name).length !== 1 ||
        !Number.isSafeInteger(job.id) || job.id < 1 || ids.has(job.id) || job.run_id !== run.id ||
        job.run_attempt !== run.run_attempt || job.head_sha !== source ||
        job.status !== 'completed' || job.conclusion !== 'success') throw new Error('release-services job identity or result mismatch');
    ids.add(job.id);
  }
}

// `repo` exists only so retained pre-rename verifier output can still be parsed;
// qualifyPreTag never passes it.
export function validateProbeAttestation(results, { source, runId, attempt, artifactSha256, repo = REPO }) {
  const identity = identityOf(repo);
  if (!Array.isArray(results) || results.length !== 1) throw new Error('expected one verified probe attestation');
  const result = results[0]?.verificationResult;
  const cert = result?.signature?.certificate;
  const statement = result?.statement;
  if (cert?.subjectAlternativeName !== identity || cert.issuer !== ISSUER ||
      cert.buildSignerURI !== identity || cert.buildSignerDigest !== source ||
      cert.sourceRepositoryURI !== `https://github.com/${repo}` || cert.sourceRepositoryDigest !== source ||
      cert.sourceRepositoryRef !== REF || cert.runnerEnvironment !== 'github-hosted' ||
      cert.runInvocationURI !== `https://github.com/${repo}/actions/runs/${runId}/attempts/${attempt}` ||
      !Array.isArray(result.verifiedTimestamps) || result.verifiedTimestamps.length === 0 ||
      statement?.predicateType !== 'https://slsa.dev/provenance/v1' ||
      !Array.isArray(statement.subject) || statement.subject.length !== 1 ||
      statement.subject[0]?.digest?.sha256 !== artifactSha256) {
    throw new Error('verified certificate, invocation or artifact binding mismatch');
  }
}

const execute = (command, args, env) => execFileSync(command, args, {
  env, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
});

export function qualifyPreTag(evidenceDir, { source, runId, run = execute } = {}) {
  if (!evidenceDir || !/^[a-f0-9]{40}$/.test(source ?? '') || !/^[1-9]\d*$/.test(String(runId ?? '')) ||
      !Number.isSafeInteger(Number(runId))) throw new Error('pre-tag qualification requires an expected source SHA and run ID');
  const root = path.resolve(evidenceDir);
  directory(root);
  // Fixed names only: no authored artifact paths, recursive searches, or success-marker authority.
  const inputs = Object.entries(PLATFORMS).map(([platform, native]) => {
    const dir = path.join(root, `release-service-probe-${platform}`);
    directory(dir);
    const bytes = Object.fromEntries(FILES.map(name => [name, readEvidence(path.join(dir, name))]));
    const expected = `Non-release signing probe\nsource=${source}\nplatform=${native}\n`;
    if (!bytes['probe.txt'].equals(Buffer.from(expected))) throw new Error(`${platform}: probe source or platform mismatch`);
    return { platform, bytes };
  });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jankurai-pretag-'));
  try {
    // Every verifier reads these same private snapshots, with empty homes/config and no injected environment.
    const env = { PATH: process.env.PATH, HOME: temporary, GH_CONFIG_DIR: temporary,
      XDG_CACHE_HOME: temporary, LANG: 'C.UTF-8' };
    const apiEnv = { ...env };
    if (process.env.GH_TOKEN) apiEnv.GH_TOKEN = process.env.GH_TOKEN;
    else if (process.env.GITHUB_TOKEN) apiEnv.GH_TOKEN = process.env.GITHUB_TOKEN;
    const api = route => JSON.parse(run('gh', ['api', '--hostname', 'github.com', `repos/${REPO}/${route}`], apiEnv));
    const workflowRun = api(`actions/runs/${runId}`);
    if (!Number.isSafeInteger(workflowRun?.run_attempt) || workflowRun.run_attempt < 1) throw new Error('invalid run attempt');
    const jobPage = api(`actions/runs/${runId}/attempts/${workflowRun.run_attempt}/jobs?per_page=100`);
    if (jobPage.total_count !== 2) throw new Error('release-services requires both exact platform jobs');
    validateProbeRun(workflowRun, jobPage.jobs, { source, runId });
    const probes = [];
    for (const { platform, bytes } of inputs) {
      const dir = path.join(temporary, platform);
      fs.mkdirSync(dir);
      for (const name of FILES) fs.writeFileSync(path.join(dir, name), bytes[name], { flag: 'wx', mode: 0o600 });
      const asset = path.join(dir, 'probe.txt');
      run('cosign', ['verify-blob', asset, '--bundle', `${asset}.sigstore.bundle`,
        '--certificate-identity', IDENTITY, '--certificate-oidc-issuer', ISSUER], env);
      const verified = JSON.parse(run('gh', ['attestation', 'verify', asset, '--bundle', `${asset}.attestation.jsonl`,
        '--repo', REPO, '--cert-identity', IDENTITY, '--cert-oidc-issuer', ISSUER,
        '--signer-digest', source, '--source-digest', source, '--source-ref', REF,
        '--deny-self-hosted-runners', '--format', 'json'], env));
      const artifactSha256 = sha256(bytes['probe.txt']);
      validateProbeAttestation(verified, { source, runId, attempt: workflowRun.run_attempt, artifactSha256 });
      probes.push({ platform, sha256: artifactSha256,
        signature_sha256: sha256(bytes['probe.txt.sigstore.bundle']),
        attestation_sha256: sha256(bytes['probe.txt.attestation.jsonl']) });
    }
    return { ok: true, kind: 'signing-service-probes', source, run_id: Number(runId),
      run_attempt: workflowRun.run_attempt, probes };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [evidenceDir, runId, ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error('usage: node scripts/pre-tag-qualify.mjs <downloaded-run-directory> <run-id>');
    const hub = fileURLToPath(new URL('..', import.meta.url));
    const source = execFileSync('git', ['-C', hub, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    console.log(JSON.stringify(qualifyPreTag(evidenceDir, { source, runId }), null, 2));
  } catch (error) {
    console.error(`pre-tag-qualify: ${error.message}`);
    process.exitCode = 1;
  }
}
