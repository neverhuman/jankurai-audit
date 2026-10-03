import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Family } from './family-model.mjs';
import { clean, exists, gitText, readToml } from './family-lib.mjs';

function validateDependencies(file, root) {
  const queue = [readToml(file)];
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
function validateTree(root) {
  for (const relative of gitText(root, 'ls-files', '-z').split('\0')) {
    const file = path.join(root, relative);
    if (!exists(file) || !fs.statSync(file).isFile() || relative.startsWith('conformance/fixtures/')) continue;
    if (path.basename(file) === 'Cargo.toml') validateDependencies(file, root);
    if (relative === 'action.yml') {
      for (const [, use] of fs.readFileSync(file, 'utf8').matchAll(/\buses:\s*["']?([^\s"'#]+)/g)) {
        if (!use.startsWith('./') && !/^[^@]+@[a-f0-9]{40}$/.test(use)) throw new Error(`${file}: unpinned action ${use}`);
      }
    }
  }
}
try {
  const family = new Family(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const checkouts = process.argv.includes('--checkouts');
  readToml(path.join(family.hub, 'Cargo.lock'));
  for (const repo of family.repos) {
    if (!family.existing(repo)) {
      if (checkouts) throw new Error(`missing component: ${repo.name}`);
      continue;
    }
    const directory = family.path(repo);
    validateTree(directory);
    for (const required of ['AGENTS.md', 'SPLIT.md', 'agent/owner-map.json', 'agent/test-map.json', 'agent/generated-zones.toml', 'scripts/ci-local.sh', 'ops/ci/required.sh']) {
      if (!exists(path.join(directory, required))) throw new Error(`${repo.name}: missing ${required}`);
    }
    const pin = family.pins.get(repo.name);
    if (checkouts && pin) {
      clean(directory);
      if (gitText(directory, 'rev-parse', 'HEAD') !== pin.commit || gitText(directory, 'rev-parse', `refs/tags/${pin.tag}^{commit}`) !== pin.commit) throw new Error(`${repo.name}: checkout/tag differs from lock`);
    }
  }
  console.log('validate-family: ok');
} catch (error) { console.error(`validate-family: ${error.message}`); process.exitCode = 1; }
