import fs from 'node:fs';
import path from 'node:path';
import TOML from '@iarna/toml';
import { gitText } from './family-lib.mjs';

function validateDependencies(file, root, io) {
  const queue = [TOML.parse(io.readFileSync(file, 'utf8'))];
  while (queue.length) {
    for (const value of Object.values(queue.pop())) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      queue.push(value);
      if (value.git && (value.branch || !(value.tag || value.rev))) throw new Error(`${file}: Git dependency needs an immutable pin`);
      if (value.path) {
        const relative = path.relative(root, path.resolve(path.dirname(file), value.path));
        if (relative.startsWith('../') || path.isAbsolute(relative)) throw new Error(`${file}: committed cross-repo path dependency`);
      }
    }
  }
}
export function validateTree(root, { io = fs, tracked = gitText(root, 'ls-files', '-z').split('\0') } = {}) {
  for (const relative of tracked) {
    const file = path.join(root, relative);
    if (!io.existsSync(file) || !io.statSync(file).isFile() || relative.startsWith('conformance/fixtures/')) continue;
    if (path.basename(file) === 'Cargo.toml') validateDependencies(file, root, io);
    if (relative === 'action.yml') {
      for (const [, use] of io.readFileSync(file, 'utf8').matchAll(/\buses:\s*["']?([^\s"'#]+)/g)) {
        if (!use.startsWith('./') && !/^[^@]+@[a-f0-9]{40}$/.test(use)) throw new Error(`${file}: unpinned action ${use}`);
      }
    }
  }
}
