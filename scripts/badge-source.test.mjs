import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { validateBadgeSource } from '../ops/ci/verify-badge-source.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const text = read('agent/badge-source/repo-score.json');
const provenance = JSON.parse(read('agent/badge-source/provenance.json'));
const baseline = read('agent/baselines/main.repo-score.json');

test('public badge uses the protected full ratchet pass and preserves the accepted baseline', () => {
  const report = validateBadgeSource(text, provenance, baseline);
  assert.equal(report.score, 91);
  assert.equal(report.git.head, 'fb97e59');
  assert.equal(JSON.parse(baseline).score, 91);
  assert.throws(() => validateBadgeSource(text + ' ', provenance, baseline));
  assert.throws(() => validateBadgeSource(text, provenance, baseline + ' '));
});

test('updated hashes cannot turn an advisory, partial, dirty or regressed report into a public pass', () => {
  for (const change of [
    report => { report.decision.status = 'advisory'; },
    report => { report.decision.passed = false; },
    report => { report.policy.mode = 'advisory'; },
    report => { report.decision.hard_findings = 1; },
    report => { report.findings.push({ hardness: 'hard' }); },
    report => { report.caps_applied.push('new-cap'); },
    report => { report.score = 90; },
    report => { report.policy.minimum_score = 0; },
    report => { report.dirty_worktree = true; },
    report => { report.scope.paths.push('one-file'); },
    report => { report.git.head = '0'.repeat(40); },
    report => { report.decision.ratchet.allowed_drop = 1; },
    report => { report.decision.ratchet.passed = false; },
  ]) {
    const report = JSON.parse(text); change(report);
    const body = JSON.stringify(report);
    assert.throws(() => validateBadgeSource(body, { ...provenance,
      report_sha256: createHash('sha256').update(body).digest('hex') }, baseline));
  }
});

test('badge provenance accepts the renamed hub and the retained pre-rename record, never a mix', () => {
  const renamed = JSON.parse(JSON.stringify(provenance).replaceAll('github.com/neverhuman/jankurai/', 'github.com/neverhuman/jankurai-audit/')
    .replace('"https://github.com/neverhuman/jankurai"', '"https://github.com/neverhuman/jankurai-audit"'));
  assert.equal(renamed.audited_repository, 'https://github.com/neverhuman/jankurai-audit');
  validateBadgeSource(text, renamed, baseline);
  for (const change of [
    value => { value.audited_repository = 'https://github.com/neverhuman/jankurai-audit'; },
    value => { value.audited_repository = 'https://github.com/counterfeit/jankurai'; },
    value => { value.source_quality_run = value.source_quality_run.replace('/jankurai/', '/jankurai-audit/'); },
    value => { value.source_quality_run += '0/extra'; },
  ]) {
    const changed = { ...provenance }; change(changed);
    assert.throws(() => validateBadgeSource(text, changed, baseline), /hosted badge provenance/);
  }
});
