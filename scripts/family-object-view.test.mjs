import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectView, objectGit as git } from './family-object-view.mjs';
import { validateTree } from './family-tree-validation.mjs';
import { validateAuditorPin } from './auditor-pin.mjs';
import { validateVendoredTrust } from './vendored-trust.mjs';

function fixture(t, edits = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'object-validation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = { 'Cargo.toml': '[package]\nname="example"\nversion="1.0.0"\n',
    'agent/auditor-pin.toml': 'version="1.7.5"\nrelease_tag="v1.7.5"\nbinary_sha256="pending"\n',
    'agent/standard-version.toml': 'auditor_version="1.7.5"\n',
    'action.yml': 'inputs:\n  release-tag:\n    default: v1.7.5\n',
    'jankurai-installer.sh': 'installer\n',
    'agent/vendor/hub-installer.lock': 'path = "jankurai-installer.sh"\n', ...edits };
  git(root, ['init', '-q']);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'tree']);
  const io = new ObjectView(); io.add(root, root, git(root, ['rev-parse', 'HEAD']));
  const family = { hub: root, repos: [{ name: 'fixture' }], path: () => root, existing: () => true };
  return { root, io, family };
}
test('Git object validation ignores dirty working bytes and applies the same validators', t => {
  const { root, io, family } = fixture(t);
  fs.writeFileSync(path.join(root, 'agent/standard-version.toml'), 'auditor_version="0.0.0"');
  validateAuditorPin(family, { io }); validateVendoredTrust(family, { io });
  validateTree(root, { io, tracked: io.tracked(root) });
  assert.throws(() => validateAuditorPin(family), /0.0.0/);
  assert.throws(() => io.readFileSync(path.join(root, '../foreign')), /outside the verified family/);
});
test('committed auditor mismatch and unpinned dependency fail object validation', t => {
  const { root, io, family } = fixture(t, {
    'agent/standard-version.toml': 'auditor_version="0.0.0"',
    'Cargo.toml': '[dependencies]\nwrong={git="https://example.invalid/repo",branch="main"}\n',
  });
  assert.throws(() => validateAuditorPin(family, { io }), /0.0.0/);
  assert.throws(() => validateTree(root, { io, tracked: io.tracked(root) }), /immutable pin/);
});
test('vendored installer tampering and extra key fail against committed hub bytes', t => {
  const { root, io, family } = fixture(t, {
    'agent/vendor/hub-installer.lock': 'path = "tampered.sh"\n',
    'tampered.sh': 'tampered', 'agent/vendor/release-keys/foreign.pub': 'foreign',
  });
  assert.throws(() => validateVendoredTrust(family, { io }), /differs from the hub/);
});
test('object reads reject symlinks instead of following them outside the committed tree', t => {
  const { root } = fixture(t);
  fs.symlinkSync('/etc/passwd', path.join(root, 'linked'));
  git(root, ['add', 'linked']);
  git(root, ['-c', 'user.name=fixture', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'link']);
  const io = new ObjectView(); io.add(root, root, git(root, ['rev-parse', 'HEAD']));
  assert.throws(() => io.readFileSync(path.join(root, 'linked')), /not a regular committed file/);
});
