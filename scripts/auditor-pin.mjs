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

/** Read and check the hub's pin declaration. */
export function auditorPin(hub) {
  const pin = readToml(path.join(hub, AUDITOR_PIN));
  if (typeof pin.version !== 'string' || !SEMVER.test(pin.version)) throw new Error(`${AUDITOR_PIN}: version must be a semantic version`);
  if (pin.release_tag !== `v${pin.version}`) throw new Error(`${AUDITOR_PIN}: release_tag must be v${pin.version}`);
  // The governed build is cut by a person, so "pending" records a hash the
  // family has not measured yet; no committed file can stand in for it.
  if (pin.binary_sha256 !== 'pending' && !/^[a-f0-9]{64}$/.test(pin.binary_sha256 ?? '')) throw new Error(`${AUDITOR_PIN}: binary_sha256 must be 64 hex characters or "pending"`);
  return pin;
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
      if (tag !== null && tag !== pin.release_tag) disagreements.push({ repo: repo.name, detail: `action.yml release-tag default ${tag} != ${pin.release_tag}` });
    }
  }
  return disagreements;
}

/** Throw naming every member that disagrees with the hub's pin. */
export function validateAuditorPin(family) {
  const pin = auditorPin(family.hub);
  const disagreements = auditorDisagreements(family, pin);
  if (!disagreements.length) return;
  const repos = new Set(disagreements.map(({ repo }) => repo));
  const lines = disagreements.map(({ repo, detail }) => `${repo}: ${detail}`);
  throw new Error(`auditor pin ${pin.version} is not held by ${repos.size} member(s):\n  ${lines.join('\n  ')}`);
}
