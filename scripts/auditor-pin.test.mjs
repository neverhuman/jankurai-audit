import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedActionDefaults, auditorPin, auditorDisagreements, validateAuditorPin } from './auditor-pin.mjs';

const hub = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The spread the fleet gate found on 2026-10-03: twelve members on 1.6.0, the
// core and kernel on 1.7.2, the proof tools on 1.6.11, and the deploy Action
// still defaulting to the v1.7.0-split.0 release tag.
const MIXED = {
  jankurai: '1.7.2',
  'jankurai-core': '1.7.2',
  'jankurai-tools-kernel': '1.7.2',
  'jankurai-tools-proof': '1.6.11',
  'jankurai-deploy': '1.6.0',
  'jankurai-standard': '1.6.0',
};
const ACTION = tag => `name: "Jankurai"\n\ninputs:\n  release-tag:\n    description: "Jankurai release tag"\n    required: false\n    default: "${tag}"\n  mode:\n    required: false\n    default: "advisory"\n`;

const CHANGELOG = '# Changelog\n\n## Unreleased\n\n## 1.7.3 - 2026-10-06\n\n## 1.7.2 - 2026-10-02\n\n## 1.7.1 - 2026-09-24\n';

/** A family tree on disk: one hub plus a checkout per declared member. */
function fixture({ pin, versions, actions = {}, changelog = CHANGELOG }, fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-pin-')));
  try {
    const hubPath = path.join(root, 'jankurai');
    for (const [name, version] of Object.entries(versions)) {
      const directory = path.join(root, name);
      fs.mkdirSync(path.join(directory, 'agent'), { recursive: true });
      fs.writeFileSync(path.join(directory, 'agent/standard-version.toml'),
        `standard = "jankurai"\nauditor_version = "${version}"\nsplit_member = "${name}"\n`);
      if (actions[name]) fs.writeFileSync(path.join(directory, 'action.yml'), ACTION(actions[name]));
    }
    fs.mkdirSync(path.join(hubPath, 'agent'), { recursive: true });
    fs.writeFileSync(path.join(hubPath, 'CHANGELOG.md'), changelog);
    fs.writeFileSync(path.join(hubPath, 'agent/auditor-pin.toml'),
      Object.entries(pin).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n'));
    const family = {
      hub: hubPath,
      repos: Object.keys(versions).map(name => ({ name, path: name })),
      path: repo => (repo.name === 'jankurai' ? hubPath : path.join(root, repo.path)),
      existing: repo => fs.existsSync(path.join(root, repo.path)),
    };
    return fn(family);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
/** The error a call threw, so one failure can be asserted line by line. */
function caught(fn) { try { fn(); } catch (error) { return error; } throw new assert.AssertionError({ message: 'expected a failure' }); }
const PIN = { schema_version: '1.0.0', version: '1.7.2', release_tag: 'v1.7.2', binary_sha256: 'pending' };

test('the mixed family fails, naming every disagreeing repository', () => {
  fixture({ pin: PIN, versions: MIXED, actions: { jankurai: 'v1.7.2', 'jankurai-deploy': 'v1.7.0-split.0' } }, family => {
    const error = caught(() => validateAuditorPin(family));
    assert.match(error.message, /auditor pin 1\.7\.2 is not held by 3 member\(s\)/);
    for (const [repo, found] of [['jankurai-tools-proof', '1.6.11'], ['jankurai-deploy', '1.6.0'], ['jankurai-standard', '1.6.0']]) {
      assert.match(error.message, new RegExp(`${repo}: agent/standard-version.toml auditor_version ${found.replaceAll('.', '\\.')} != 1\\.7\\.2`));
    }
    // Agreeing members are not named, and the hub's own Action default is fine.
    assert.doesNotMatch(error.message, /jankurai-core|jankurai-tools-kernel/);
    assert.doesNotMatch(error.message, /release-tag default v1\.7\.2/);
  });
});

test('the stale Action default is named even when the member agrees', () => {
  fixture({ pin: PIN, versions: { jankurai: '1.7.2', 'jankurai-deploy': '1.7.2' }, actions: { 'jankurai-deploy': 'v1.7.0-split.0' } }, family => {
    assert.throws(() => validateAuditorPin(family),
      /jankurai-deploy: action\.yml release-tag default v1\.7\.0-split\.0 != v1\.7\.2/);
  });
});

test('a family that agrees everywhere passes', () => {
  const versions = Object.fromEntries(Object.keys(MIXED).map(name => [name, '1.7.2']));
  fixture({ pin: PIN, versions, actions: { jankurai: 'v1.7.2', 'jankurai-deploy': 'v1.7.2' } }, family => {
    validateAuditorPin(family);
    assert.deepEqual(auditorDisagreements(family, PIN), []);
  });
});

test('absent members are not judged; an absent declaration is', () => {
  fixture({ pin: PIN, versions: { jankurai: '1.7.2', 'jankurai-core': '1.7.2' } }, family => {
    family.repos.push({ name: 'jankurai-tools-fleet', path: 'jankurai-tools-fleet' });
    validateAuditorPin(family);
    fs.writeFileSync(path.join(family.path({ name: 'jankurai-core', path: 'jankurai-core' }), 'agent/standard-version.toml'), 'standard = "jankurai"\n');
    assert.throws(() => validateAuditorPin(family), /jankurai-core: agent\/standard-version\.toml auditor_version \(absent\) != 1\.7\.2/);
  });
});

for (const [name, bad] of [
  ['a non-semver version', { ...PIN, version: 'latest' }],
  ['a release tag that is not the pinned version', { ...PIN, release_tag: 'v1.7.0-split.0' }],
  ['a binary hash that is neither hex nor pending', { ...PIN, binary_sha256: 'soon' }],
  ['a previous published release that is the pinned release', { ...PIN, previous_published_release_tag: 'v1.7.2' }],
  ['a previous published release later than the pin', { ...PIN, previous_published_release_tag: 'v1.7.3' }],
  ['a previous published release that is a pre-release', { ...PIN, previous_published_release_tag: 'v1.7.1-rc1' }],
  ['a previous published release that is not a tag', { ...PIN, previous_published_release_tag: '1.7.1' }],
]) test(`the pin itself is rejected: ${name}`, () => {
  fixture({ pin: bad, versions: { jankurai: '1.7.2' } }, family => {
    assert.throws(() => validateAuditorPin(family), /agent\/auditor-pin\.toml:/);
  });
});

// While the pinned release is being cut, an Action may keep defaulting to the
// last published release so the default installs something; the pin must name
// that release, and only it.
const CUTTING = { ...PIN, version: '1.7.3', release_tag: 'v1.7.3', previous_published_release_tag: 'v1.7.2', previous_published_release_expires: '2026-11-14' };
const BEFORE_EXPIRY = { now: new Date('2026-11-14T23:59:59Z') };
const AFTER_EXPIRY = { now: new Date('2026-11-15T00:00:00Z') };

test('an Action default may be the previous published release the pin names', () => {
  fixture({ pin: CUTTING, versions: { jankurai: '1.7.3', 'jankurai-deploy': '1.7.3' }, actions: { jankurai: 'v1.7.3', 'jankurai-deploy': 'v1.7.2' } }, family => {
    validateAuditorPin(family, BEFORE_EXPIRY);
    assert.deepEqual(acceptedActionDefaults(auditorPin(family.hub, BEFORE_EXPIRY)), ['v1.7.3', 'v1.7.2']);
  });
});

test('without the pin naming it, the previous release is still a disagreement', () => {
  const { previous_published_release_tag: _omitted, previous_published_release_expires: _alsoOmitted, ...pin } = CUTTING;
  fixture({ pin, versions: { jankurai: '1.7.3', 'jankurai-deploy': '1.7.3' }, actions: { 'jankurai-deploy': 'v1.7.2' } }, family => {
    assert.throws(() => validateAuditorPin(family), /jankurai-deploy: action\.yml release-tag default v1\.7\.2 != v1\.7\.3$/m);
  });
});

test('any other Action default is refused even with a previous release named', () => {
  for (const tag of ['v1.7.1', 'v1.7.4', 'v1.7.3-rc1', 'latest']) {
    fixture({ pin: CUTTING, versions: { jankurai: '1.7.3', 'jankurai-deploy': '1.7.3' }, actions: { 'jankurai-deploy': tag } }, family => {
      assert.throws(() => validateAuditorPin(family, BEFORE_EXPIRY),
        new RegExp(`jankurai-deploy: action\\.yml release-tag default ${tag.replaceAll('.', '\\.')} != v1\\.7\\.3 or v1\\.7\\.2`), tag);
    });
  }
});

test('the allowance never relaxes auditor_version', () => {
  fixture({ pin: CUTTING, versions: { jankurai: '1.7.3', 'jankurai-deploy': '1.7.2' } }, family => {
    assert.throws(() => validateAuditorPin(family, BEFORE_EXPIRY), /jankurai-deploy: agent\/standard-version\.toml auditor_version 1\.7\.2 != 1\.7\.3/);
  });
});

// The allowance restores the strict gate by itself: it names only the release
// right before the pin, lapses once the pinned release is cut, and expires.
const DEPLOY_ON_PREVIOUS = { versions: { jankurai: '1.7.3', 'jankurai-deploy': '1.7.3' }, actions: { 'jankurai-deploy': 'v1.7.2' } };
for (const [name, pin, message, options = BEFORE_EXPIRY, changelog] of [
  ['an older release than the one right before the pin', { ...CUTTING, previous_published_release_tag: 'v1.7.1' }, /v1\.7\.1 must be the release immediately before v1\.7\.3 in CHANGELOG\.md \(v1\.7\.2\)/],
  ['a pin with no earlier release in CHANGELOG.md', CUTTING, /must be the release immediately before v1\.7\.3 in CHANGELOG\.md \(none found\)/, BEFORE_EXPIRY, '# Changelog\n\n## 1.7.3 - 2026-10-06\n'],
  ['a pinned release that is already cut', { ...CUTTING, binary_sha256: 'a'.repeat(64) }, /allowed only while binary_sha256 is "pending"/],
  ['no expiry date', (({ previous_published_release_expires: _omitted, ...pin }) => pin)(CUTTING), /needs previous_published_release_expires/],
  ['an expiry that is not a date', { ...CUTTING, previous_published_release_expires: 'soon' }, /needs previous_published_release_expires/],
  ['an expired allowance', CUTTING, /allowance expired on 2026-11-14/, AFTER_EXPIRY],
  ['an expiry date without the tag', (({ previous_published_release_tag: _omitted, ...pin }) => pin)(CUTTING), /previous_published_release_expires without previous_published_release_tag/],
]) test(`the Action-default allowance is refused: ${name}`, () => {
  fixture({ ...DEPLOY_ON_PREVIOUS, pin, ...(changelog ? { changelog } : {}) }, family => {
    assert.throws(() => validateAuditorPin(family, options), message);
  });
});

test('the hub declares a pin it holds itself', () => {
  const pin = auditorPin(hub);
  assert.equal(pin.version, '1.7.6');
  assert.deepEqual(auditorDisagreements({ hub, repos: [{ name: 'jankurai', path: 'jankurai' }], path: () => hub, existing: () => true }, pin), []);
});
