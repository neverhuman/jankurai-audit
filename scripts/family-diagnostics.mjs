import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const reports = [
  'candidate.lock', 'jankurai/family.lock', 'jankurai/Cargo.lock',
  'jankurai/agent/baselines/main.repo-score.json',
  'jankurai/.jankurai/repo-score.json', 'jankurai/.jankurai/repo-score.md',
  'jankurai/target/jankurai/repo-score.json', 'jankurai/target/jankurai/repo-score.md',
  'jankurai/target/jankurai/conformance.json', 'jankurai/target/jankurai/conformance.md',
  'jankurai/target/jankurai/conformance.tex',
  'jankurai/target/jankurai/auditor.sha256', 'jankurai/target/jankurai/auditor-reports.sha256',
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function regularDirectories(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.lstatSync(current).isDirectory()) throw new Error(`diagnostics directory is redirected: ${current}`);
  }
}

function stableBytes(file) {
  regularDirectories(path.dirname(file));
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.size > 32 * 1024 * 1024) throw new Error(`diagnostic is not a bounded regular file: ${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0, count;
    while ((count = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    const opened = fs.fstatSync(fd), named = fs.lstatSync(file);
    for (const stat of [opened, named]) for (const key of ['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs']) {
      if (stat[key] !== before[key]) throw new Error(`diagnostic changed during preservation: ${file}`);
    }
    regularDirectories(path.dirname(file));
    if (length !== before.size) throw new Error(`diagnostic read was incomplete: ${file}`);
    return bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
}

function durableWrite(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Candidate outputs remain untrusted diagnostic data, including invalid JSON. */
export function preserveCandidateDiagnostics(candidate, parent, error) {
  regularDirectories(candidate);
  regularDirectories(path.dirname(parent));
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  regularDirectories(parent);
  const destination = fs.mkdtempSync(path.join(parent, 'run-'));
  const manifest = { schema: 1, trust: 'untrusted-candidate-diagnostics', source: candidate,
    recorded_at: new Date().toISOString(), failure: String(error?.message ?? error), files: [] };
  try {
    for (const name of reports) {
      const source = path.join(candidate, name);
      let bytes;
      try { bytes = stableBytes(source); }
      catch (error) {
        if (error.code === 'ENOENT') { manifest.files.push({ source: name, status: 'absent' }); continue; }
        throw error;
      }
      const filename = `${manifest.files.length}-${path.basename(name)}`;
      durableWrite(path.join(destination, filename), bytes);
      manifest.files.push({ source: name, file: filename, sha256: sha256(bytes), size: bytes.length, status: 'preserved' });
    }
    durableWrite(path.join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const directory of [destination, parent]) {
      const fd = fs.openSync(directory, fs.constants.O_RDONLY);
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    console.error(`candidate failure diagnostics preserved: ${destination}`);
    return destination;
  } catch (cause) {
    throw new Error(`candidate diagnostic export failed; partial evidence retained at ${destination}`, { cause });
  }
}
