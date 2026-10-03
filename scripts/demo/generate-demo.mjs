#!/usr/bin/env node
// Normal CI: audit an explicitly authored sample, then verify its recorded GIF.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sha256, validateRecording, outcome } from './audit-recording.mjs';
import { render } from './render-audit-gif.mjs';
import { cleanupSample } from './sample-cleanup.mjs';
import { captureProducerState } from './producer-state.mjs';
import { redactCapture } from './redact-capture.mjs';

const [auditor, destination] = process.argv.slice(2);
if (!auditor || !path.isAbsolute(auditor) || !destination) throw new Error('usage: generate-demo.mjs /absolute/qualified-auditor /new-output-directory');
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(destination);
fs.mkdirSync(root);
const sample = path.join(root, 'sample-repository'); fs.mkdirSync(sample);
fs.mkdirSync(path.join(sample, 'src'));
const inventory = [];
const write = (name, content) => {
  fs.writeFileSync(path.join(sample, name), content, { flag: 'wx' });
  inventory.push({ name, sha256: sha256(content) });
};
write('README.md', '# Sample repository\n\nAn intentionally incomplete authored sample for a real Jankurai audit.\nThe displayed score and failures are measured, never substituted.\n');
write('Cargo.toml', '[package]\nname="audit-demo-sample"\nversion="0.1.0"\nedition="2021"\n');
write('src/lib.rs', 'pub fn sample() -> u64 { 42 }\n');
for (let index = 0; index < 2000; index++) {
  const functions = Array.from({ length: 32 }, (_, row) => `pub fn value_${index}_${row}(x: u64) -> u64 { x.wrapping_add(${index * 32 + row}) }`).join('\n') + '\n';
  write(`src/sample_${String(index).padStart(4, '0')}.rs`, functions);
}
const capture = path.join(root, 'recording');
const producerOutputs = [];
let fatal = null;
try {
  const execution = spawnSync(process.execPath, [path.join(here, 'record-audit.mjs'), auditor, sample, capture], { stdio: 'inherit' });
  const recordingBytes = fs.readFileSync(path.join(capture, 'recording.json'));
  const recording = validateRecording(JSON.parse(recordingBytes));
  const result = outcome(recording);
  if (execution.signal || recording.result.signal || recording.result.error || !result.summary
      || ![0, 1].includes(recording.result.exitCode)
      || execution.status !== recording.result.exitCode
      || (recording.result.exitCode === 0) !== result.summary.policyPassed
      || result.passed || recording.result.exitCode !== 1) {
    throw new Error('sample audit did not complete with a consistent real policy outcome');
  }
  // The capture names producer-local absolute paths; publish placeholders.
  const redactedBytes = redactCapture(capture);
  const redacted = validateRecording(JSON.parse(redactedBytes));
  producerOutputs.push(captureProducerState(sample, redacted, capture));
  // This job verifies an honest demo; an explicitly displayed sample policy FAIL
  // is allowed. Missing execution/report and contradictory outcomes remain fatal.
  const rendered = path.join(root, 'rendered');
  render(redactedBytes, rendered);
  const verify = spawnSync(process.execPath, [path.join(here, 'verify-audit-gif.mjs'), rendered, '--pixels-only'], { stdio: 'inherit' });
  if (verify.status !== 0) throw new Error('independent decoded pixel verification failed');
  fs.writeFileSync(path.join(capture, 'sample-inputs.json'), JSON.stringify({
    description: 'Real audit of an authored sample repository; policy failures are preserved.',
    inventory, sourceSha256: sha256(JSON.stringify(inventory)), producerOutputs,
    recordingSha256: sha256(redactedBytes), expectedSampleOutcome: 'FAIL', measuredOutcome: result,
  }, null, 2) + '\n', { flag: 'wx' });
} catch (error) {
  fatal = error;
} finally {
  try {
    cleanupSample(sample, [...inventory, ...producerOutputs]);
  } catch (cleanupError) {
    fatal ||= cleanupError;
  }
}
if (fatal) throw fatal;
