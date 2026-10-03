import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyEvidence } from './demo-evidence.mjs';
import { redactCapture, redactions, PLACEHOLDER_ROOT } from './redact-capture.mjs';
import { CAPTURE_FILES, RECEIPT } from './demo-catalog.mjs';

const catalog = fileURLToPath(new URL('../../docs/demo/', import.meta.url));
// Invented producer locations; the committed catalog is only ever read here.
const PRODUCER_ROOT = '/home/someone/workspace/audit-run';
const PRODUCER_SAMPLE = `${PRODUCER_ROOT}/sample-repository`;
const PRODUCER_AUDITOR = '/home/someone/builds/release/jankurai';

function flatFixture(run) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jankurai-redaction-control-')));
  try {
    for (const name of [RECEIPT, ...Object.keys(CAPTURE_FILES)]) fs.copyFileSync(path.join(catalog, name), path.join(directory, name));
    run(directory);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

/// Put producer-local paths back into a copy of the catalog, as a fresh capture
/// on a producer's machine would carry them.
function unredact(directory) {
  const swap = text => text
    .split(`${PLACEHOLDER_ROOT}/sample-repository`).join(PRODUCER_SAMPLE)
    .split(`${PLACEHOLDER_ROOT}/jankurai`).join(PRODUCER_AUDITOR)
    .split(PLACEHOLDER_ROOT).join(PRODUCER_ROOT);
  const recordingFile = path.join(directory, 'audit-recording.json');
  const reportFile = path.join(directory, 'report.json');
  const reportText = swap(fs.readFileSync(reportFile, 'utf8'));
  const recording = JSON.parse(swap(fs.readFileSync(recordingFile, 'utf8')));
  recording.result.report = JSON.parse(reportText);
  fs.writeFileSync(reportFile, reportText);
  fs.writeFileSync(recordingFile, JSON.stringify(recording, null, 2) + '\n');
  return { recordingFile, reportFile };
}

test('redactions map the auditor, the sample and the producer root', () => {
  const pairs = redactions({ identity: { executable: PRODUCER_AUDITOR, repository: PRODUCER_SAMPLE } });
  assert.deepEqual(pairs, [
    [PRODUCER_SAMPLE, `${PLACEHOLDER_ROOT}/sample-repository`],
    [PRODUCER_AUDITOR, `${PLACEHOLDER_ROOT}/jankurai`],
    [PRODUCER_ROOT, PLACEHOLDER_ROOT],
  ]);
});

test('a recording without an absolute producer path cannot be redacted', () => {
  assert.throws(() => redactions({ identity: { repository: 'sample-repository' } }), /absolute producer path/);
});

test('redacting a producer capture restores a verifiable path-free catalog', () => flatFixture(directory => {
  unredact(directory);
  assert.match(fs.readFileSync(path.join(directory, 'audit-recording.json'), 'utf8'), /\/home\/someone\//);

  redactCapture(directory);

  for (const name of [RECEIPT, ...Object.keys(CAPTURE_FILES)]) {
    const text = fs.readFileSync(path.join(directory, name), 'utf8');
    assert.ok(!text.includes('/home/'), `${name} still names a home path`);
    assert.ok(!text.includes('/Users/'), `${name} still names a home path`);
  }
  const recording = verifyEvidence(directory);
  assert.equal(recording.identity.repository, `${PLACEHOLDER_ROOT}/sample-repository`);
  assert.equal(recording.identity.executable, `${PLACEHOLDER_ROOT}/jankurai`);
  assert.ok(recording.identity.argv.every(argument => !argument.includes('/home/')));
}));

test('redaction is idempotent, so the committed catalog stays byte-identical', () => flatFixture(directory => {
  const before = Object.fromEntries([RECEIPT, ...Object.keys(CAPTURE_FILES)]
    .map(name => [name, fs.readFileSync(path.join(directory, name))]));
  redactCapture(directory);
  for (const [name, bytes] of Object.entries(before)) {
    assert.deepEqual(fs.readFileSync(path.join(directory, name)), bytes, `${name} changed`);
  }
}));

test('an unmapped producer path refuses to be published', () => flatFixture(directory => {
  unredact(directory);
  const file = path.join(directory, 'stdout.txt');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '\ncache: /home/someone/.cache/jankurai\n');
  assert.throws(() => redactCapture(directory), /still contains a producer path/);
}));
