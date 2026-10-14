// The family auditor pin: one declared auditor version for every member.
//
// Members used to declare their own `auditor_version` in
// agent/standard-version.toml and their own `release-tag` action default, so
// scores and baselines could come from different engines without anything
// noticing. agent/auditor-pin.toml is now the single source, and
// scripts/validate-family.mjs rejects any member that leaves it.
import fs from 'node:fs';
import path from 'node:path';
import { exists, readToml } from './family-lib.mjs';

export const AUDITOR_PIN = 'agent/auditor-pin.toml';
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * Read and check the hub's pin declaration. `now` decides whether a temporary
 * Action-default allowance has expired; it is a parameter only so tests can
 * move the clock.
 */
export function auditorPin(hub, { now = new Date() } = {}) {
  const pin = readToml(path.join(hub, AUDITOR_PIN));
  if (typeof pin.version !== 'string' || !SEMVER.test(pin.version)) throw new Error(`${AUDITOR_PIN}: version must be a semantic version`);
  if (pin.release_tag !== `v${pin.version}`) throw new Error(`${AUDITOR_PIN}: release_tag must be v${pin.version}`);
  // The governed build is cut by a person, so "pending" records a hash the
  // family has not measured yet; no committed file can stand in for it.
  if (pin.binary_sha256 !== 'pending' && !/^[a-f0-9]{64}$/.test(pin.binary_sha256 ?? '')) throw new Error(`${AUDITOR_PIN}: binary_sha256 must be 64 hex characters or "pending"`);
  validatePreviousRelease(hub, pin, now);
  return pin;
}

// While the pinned release is being cut, an Action may keep defaulting to the
// release immediately before it, so consumers who take the default can install
// something. The allowance is bounded three ways, so the gate restores itself:
// it names exactly that one release (the one before the pin in CHANGELOG.md),
// it is valid only while binary_sha256 is "pending" (the pinned release is not
// cut yet), and it carries an expiry date after which validation fails until it
// is removed.
function validatePreviousRelease(hub, pin, now) {
  const previous = pin.previous_published_release_tag;
  const expires = pin.previous_published_release_expires;
  if (previous === undefined) {
    if (expires !== undefined) throw new Error(`${AUDITOR_PIN}: previous_published_release_expires without previous_published_release_tag`);
    return;
  }
  const match = typeof previous === 'string' && previous.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`${AUDITOR_PIN}: previous_published_release_tag must be a release tag vX.Y.Z (no pre-release)`);
  if (compareCore(match.slice(1, 4).map(Number), coreOf(pin.version)) >= 0) {
    throw new Error(`${AUDITOR_PIN}: previous_published_release_tag ${previous} must be an earlier release than ${pin.release_tag}`);
  }
  const before = releaseBefore(hub, pin.version);
  if (`v${before}` !== previous) {
    throw new Error(`${AUDITOR_PIN}: previous_published_release_tag ${previous} must be the release immediately before ${pin.release_tag} in CHANGELOG.md (${before ? `v${before}` : 'none found'})`);
  }
  if (pin.binary_sha256 !== 'pending') {
    throw new Error(`${AUDITOR_PIN}: previous_published_release_tag is allowed only while binary_sha256 is "pending"; ${pin.release_tag} is cut, so move the Action defaults to it and remove the allowance`);
  }
  if (typeof expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expires) || Number.isNaN(Date.parse(`${expires}T00:00:00Z`))) {
    throw new Error(`${AUDITOR_PIN}: previous_published_release_tag needs previous_published_release_expires, an ISO date YYYY-MM-DD`);
  }
  if (now.getTime() >= Date.parse(`${expires}T00:00:00Z`) + 86400000) {
    throw new Error(`${AUDITOR_PIN}: the ${previous} Action-default allowance expired on ${expires}; publish ${pin.release_tag}, move the Action defaults to it and remove the allowance`);
  }
}

/** The release heading in the hub CHANGELOG.md right after `version`'s, or null. */
function releaseBefore(hub, version) {
  const file = path.join(hub, 'CHANGELOG.md');
  if (!exists(file)) return null;
  const releases = [...fs.readFileSync(file, 'utf8').matchAll(/^## (\d+\.\d+\.\d+) - /gm)].map(([, found]) => found);
  const index = releases.indexOf(version);
  return index >= 0 && index + 1 < releases.length ? releases[index + 1] : null;
}

function coreOf(version) { return version.split(/[-+]/)[0].split('.').map(Number); }
function compareCore(a, b) { for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }

/**
 * The release-tag defaults an Action may carry: the pinned release, or also the
 * release immediately before it while the pin names it (see above).
 */
export function acceptedActionDefaults(pin) {
  return pin.previous_published_release_tag ? [pin.release_tag, pin.previous_published_release_tag] : [pin.release_tag];
}

/** The `release-tag` input default of an action.yml, or null when it has none. */
function releaseTagDefault(file) {
  const block = fs.readFileSync(file, 'utf8').match(/^ {2}release-tag:[ \t]*\n((?: {4,}.*\n|[ \t]*\n)*)/m);
  return block?.[1].match(/^ {4}default:\s*["']?([^\s"'#]+)/m)?.[1] ?? null;
}

/** `{ repo, detail }` per present member whose declaration leaves the pin. */
export function auditorDisagreements(family, pin) {
  const disagreements = [];
  for (const repo of family.repos) {
    if (!family.existing(repo)) continue;
    const directory = family.path(repo);
    const declared = path.join(directory, 'agent/standard-version.toml');
    if (exists(declared)) {
      const found = readToml(declared).auditor_version;
      if (found !== pin.version) disagreements.push({ repo: repo.name, detail: `agent/standard-version.toml auditor_version ${found ?? '(absent)'} != ${pin.version}` });
    }
    const action = path.join(directory, 'action.yml');
    if (exists(action)) {
      const tag = releaseTagDefault(action);
      const accepted = acceptedActionDefaults(pin);
      if (tag !== null && !accepted.includes(tag)) {
        disagreements.push({ repo: repo.name, detail: `action.yml release-tag default ${tag} != ${accepted.join(' or ')}${accepted.length > 1 ? ' (the pinned release or the previous published release named in the pin)' : ''}` });
      }
    }
  }
  return disagreements;
}

/** Throw naming every member that disagrees with the hub's pin. */
export function validateAuditorPin(family, options = {}) {
  const pin = auditorPin(family.hub, options);
  const disagreements = auditorDisagreements(family, pin);
  if (!disagreements.length) return;
  const repos = new Set(disagreements.map(({ repo }) => repo));
  const lines = disagreements.map(({ repo, detail }) => `${repo}: ${detail}`);
  throw new Error(`auditor pin ${pin.version} is not held by ${repos.size} member(s):\n  ${lines.join('\n  ')}`);
}
