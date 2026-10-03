#!/usr/bin/env node
// Replace producer-local absolute paths in a capture with stable placeholders.
//
// A recording necessarily observes wherever the producer ran: the auditor
// binary, the authored sample and the capture directory are absolute paths on
// that machine. Those are site specifics, and this catalog is published, so the
// capture is rewritten to placeholder paths before it is rendered or published.
// Rendering only ever displays `basename(identity.repository)`, so redaction
// changes no displayed pixel; it does change the capture bytes, and every digest
// that binds them is recomputed here so the catalog stays self-consistent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, validateRecording } from './audit-recording.mjs';

export const PLACEHOLDER_ROOT = '/jankurai-audit-demo';

// Flat published catalog names → fresh capture names.
const FLAT_RECORDING = 'audit-recording.json';
const CAPTURE_RECORDING = 'recording.json';

/// Longest-first prefix replacements derived from the recording's own identity.
export function redactions(recording) {
  const repository = recording.identity?.repository;
  const executable = recording.identity?.executable;
  const pairs = [];
  if (typeof executable === 'string' && path.isAbsolute(executable)) {
    pairs.push([executable, `${PLACEHOLDER_ROOT}/${path.basename(executable)}`]);
  }
  if (typeof repository === 'string' && path.isAbsolute(repository)) {
    // The producer root holds the sample and the capture directory beside it.
    pairs.push([repository, `${PLACEHOLDER_ROOT}/${path.basename(repository)}`]);
    pairs.push([path.dirname(repository), PLACEHOLDER_ROOT]);
  }
  if (!pairs.length) throw new Error('recording identity names no absolute producer path');
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

function apply(text, pairs) {
  return pairs.reduce((value, [from, to]) => value.split(from).join(to), text);
}

/// Any absolute home path left behind means an unmapped producer location: fail
/// loudly rather than publish it.
export function assertNoSitePaths(entries) {
  const markers = ['/home/', '/Users/', '/root/', os.homedir()].filter(Boolean);
  for (const [name, text] of entries) {
    for (const marker of markers) {
      if (text.includes(marker)) {
        throw new Error(`${name} still contains a producer path (${marker}); map it in redactions()`);
      }
    }
  }
}

const json = value => JSON.stringify(value, null, 2) + '\n';

/// Redact `directory` in place, accepting either a fresh capture directory or a
/// published flat catalog, and return the redacted recording bytes.
export function redactCapture(directory) {
  const dir = path.resolve(directory);
  const flat = fs.existsSync(path.join(dir, FLAT_RECORDING));
  const recordingName = flat ? FLAT_RECORDING : CAPTURE_RECORDING;
  const read = name => fs.readFileSync(path.join(dir, name), 'utf8');
  const write = (name, text) => fs.writeFileSync(path.join(dir, name), text);
  const optional = name => (fs.existsSync(path.join(dir, name)) ? read(name) : null);

  const recording = validateRecording(JSON.parse(read(recordingName)));
  const pairs = redactions(recording);

  const reportText = apply(read('report.json'), pairs);
  const stdoutText = apply(read('stdout.txt'), pairs);
  const stderrText = apply(read('stderr.txt'), pairs);
  const redacted = JSON.parse(apply(JSON.stringify(recording), pairs));
  redacted.result.report = JSON.parse(reportText);
  redacted.result.reportSha256 = sha256(reportText);
  redacted.stdoutSha256 = sha256(stdoutText);
  redacted.stderrSha256 = sha256(stderrText);
  const recordingText = json(validateRecording(redacted));
  const recordingSha256 = sha256(recordingText);

  const written = [
    [recordingName, recordingText],
    ['report.json', reportText],
    ['stdout.txt', stdoutText],
    ['stderr.txt', stderrText],
  ];

  const inputsText = optional('sample-inputs.json');
  if (inputsText !== null) {
    const inputs = JSON.parse(apply(inputsText, pairs));
    inputs.recordingSha256 = recordingSha256;
    for (const output of inputs.producerOutputs ?? []) output.reportSha256 = redacted.result.reportSha256;
    written.push(['sample-inputs.json', json(inputs)]);
  }
  const manifestText = optional('audit-demo.json');
  if (manifestText !== null) {
    const manifest = JSON.parse(apply(manifestText, pairs));
    manifest.recordingSha256 = recordingSha256;
    written.push(['audit-demo.json', json(manifest)]);
  }

  assertNoSitePaths(written);
  for (const [name, text] of written) write(name, text);
  return Buffer.from(recordingText);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory] = process.argv.slice(2);
  if (!directory) throw new Error('usage: redact-capture.mjs CAPTURE-OR-CATALOG-DIR');
  redactCapture(directory);
  console.log(`redacted producer paths in ${path.resolve(directory)} to ${PLACEHOLDER_ROOT}`);
}
