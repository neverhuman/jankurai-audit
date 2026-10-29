// A read-only filesystem view of immutable Git trees. No checkout or clone.
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function objectGit(directory, args, { allowFailure = false, binary = false } = {}) {
  const out = spawnSync('git', ['-C', directory, ...args], {
    encoding: binary ? undefined : 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (out.error) throw out.error;
  if (out.status !== 0 && !allowFailure) throw new Error(`git ${args.join(' ')} in ${directory}: ${String(out.stderr || '').trim()}`);
  return out.status === 0 ? (binary ? out.stdout : out.stdout.trim()) : null;
}

export class ObjectView {
  constructor() { this.trees = new Map(); }
  add(root, repository, commit) {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('object view requires an exact commit');
    const entries = new Map();
    for (const row of objectGit(repository, ['ls-tree', '-rz', '--full-tree', commit]).split('\0').filter(Boolean)) {
      const tab = row.indexOf('\t');
      const [mode, type, oid] = row.slice(0, tab).split(' ');
      entries.set(row.slice(tab + 1), { mode, type, oid });
    }
    this.trees.set(path.resolve(root), { repository, commit, entries });
  }
  locate(file) {
    for (const [root, tree] of this.trees) {
      const relative = path.relative(root, file);
      if (relative === '' || (!relative.startsWith('../') && !path.isAbsolute(relative))) return { ...tree, relative };
    }
    throw new Error(`path is outside the verified family: ${file}`);
  }
  existsSync(file) {
    const { entries, relative } = this.locate(file);
    return entries.has(relative) || [...entries.keys()].some(p => p.startsWith(relative + '/'));
  }
  statSync(file) {
    const { entries, relative } = this.locate(file);
    const entry = entries.get(relative);
    if (entry?.mode === '120000' || entry?.type === 'commit') throw new Error(`non-regular source metadata: ${file}`);
    return { isFile: () => entry?.type === 'blob' };
  }
  readFileSync(file, encoding) {
    const { repository, entries, relative } = this.locate(file);
    const entry = entries.get(relative);
    if (!entry || entry.type !== 'blob' || entry.mode === '120000') throw new Error(`not a regular committed file: ${file}`);
    const bytes = objectGit(repository, ['cat-file', 'blob', entry.oid], { binary: true });
    return encoding ? bytes.toString(encoding) : bytes;
  }
  readdirSync(directory) {
    const { entries, relative } = this.locate(directory);
    return [...new Set([...entries.keys()].filter(p => p.startsWith(relative + '/')).map(p => p.slice(relative.length + 1).split('/')[0]))];
  }
  tracked(root) { return [...this.trees.get(path.resolve(root)).entries.keys()]; }
}
