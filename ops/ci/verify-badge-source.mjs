// Validate the retained public score; this does not grant execution authority.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const digest = text => createHash('sha256').update(text).digest('hex');
// The hub was renamed from neverhuman/jankurai to neverhuman/jankurai-audit after
// v1.7.1. A retained record keeps the name it was captured under, so both are
// accepted, but its run and job links must name the same repository.
const BADGE_REPOSITORIES = ['https://github.com/neverhuman/jankurai-audit', 'https://github.com/neverhuman/jankurai'];

export function validateBadgeSource(text, provenance, baselineText) {
  const report = JSON.parse(text), decision = report.decision, ratchet = decision?.ratchet;
  if (digest(text) !== provenance.report_sha256 || digest(baselineText) !== provenance.baseline_sha256 ||
      report.report_fingerprint !== provenance.report_fingerprint) throw new Error('badge evidence digest mismatch');
  for (const key of ['audited_commit', 'audited_tree', 'auditor_core_revision']) {
    if (!/^[a-f0-9]{40}$/.test(provenance[key])) throw new Error(`invalid badge ${key}`);
  }
  const repository = provenance.audited_repository;
  if (!BADGE_REPOSITORIES.includes(repository) || typeof provenance.source_quality_run !== 'string' ||
      !provenance.source_quality_run.startsWith(repository + '/actions/runs/') ||
      !/^\/actions\/runs\/[1-9]\d*$/.test(provenance.source_quality_run.slice(repository.length)) ||
      !provenance.source_quality_job?.startsWith(provenance.source_quality_run + '/job/') ||
      !/\/job\/[1-9]\d*$/.test(provenance.source_quality_job) ||
      !Number.isSafeInteger(provenance.artifact_id) || provenance.artifact_id < 1 ||
      !/^[a-f0-9]{64}$/.test(provenance.artifact_sha256)) throw new Error('missing hosted badge provenance');
  if (!/^[a-f0-9]{7,40}$/.test(report.git?.head) || !provenance.audited_commit.startsWith(report.git.head) ||
      report.dirty_worktree !== false || report.git.dirty_worktree !== false || report.git.mode !== 'full' ||
      report.scope?.mode !== 'full' || !Array.isArray(report.scope.paths) || report.scope.paths.length !== 0) {
    throw new Error('badge requires a clean full audit of its recorded revision');
  }
  if (provenance.mode !== 'ratchet' || provenance.scope !== 'full' || report.policy?.mode !== 'ratchet' ||
      decision?.status !== 'pass' || decision.passed !== true || decision.hard_findings !== 0 ||
      !Number.isInteger(report.score) || report.score > 100 || !Number.isInteger(decision.minimum_score) ||
      !Number.isInteger(report.policy.minimum_score) || report.policy.minimum_score < 85 ||
      decision.minimum_score < report.policy.minimum_score || report.score < decision.minimum_score ||
      !Array.isArray(report.caps_applied) || report.caps_applied.length !== 0 ||
      !Array.isArray(report.findings) || report.findings.some(f => f.hardness === 'hard') ||
      ratchet?.passed !== true || ratchet.allowed_drop !== 0 ||
      ratchet.baseline_score !== JSON.parse(baselineText).score || report.score < ratchet.baseline_score ||
      !Array.isArray(ratchet.new_caps) || ratchet.new_caps.length !== 0 ||
      !Array.isArray(ratchet.new_hard_findings) || ratchet.new_hard_findings.length !== 0 || ratchet.policy_changed !== false) {
    throw new Error('badge requires a passing ratchet without a reduced baseline or hard findings');
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const provenance = JSON.parse(fs.readFileSync('agent/badge-source/provenance.json', 'utf8'));
  validateBadgeSource(fs.readFileSync('agent/badge-source/repo-score.json', 'utf8'), provenance,
    fs.readFileSync('agent/baselines/main.repo-score.json', 'utf8'));
  const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
  if (git(['rev-parse', `${provenance.audited_commit}^{tree}`]) !== provenance.audited_tree) throw new Error('badge source tree mismatch');
  git(['merge-base', '--is-ancestor', provenance.audited_commit, 'HEAD']);
  const lock = execFileSync('git', ['show', `${provenance.audited_commit}:family.lock`]);
  const core = lock.toString().split('[[repo]]').filter(block => /^repo = "jankurai-core"$/m.test(block));
  if (digest(lock) !== provenance.family_lock_sha256 || core.length !== 1 ||
      !core[0].split('\n').includes(`commit = "${provenance.auditor_core_revision}"`)) {
    throw new Error('badge auditor selection differs from the audited source');
  }
  console.log(`verified public badge source ${provenance.audited_commit}`);
}
