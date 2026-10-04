// The family gate contract: one lane surface for every member.
//
// Every member's AGENTS.md says to run `bash scripts/ci-local.sh required`, but
// nothing used to define the lane set or what `required` has to prove, so the
// lanes, the default and the strength of `required` drifted per repository.
// contracts/gate-contract.md is now the definition and this module checks a
// member checkout against it: it parses scripts/ci-local.sh for the lane
// surface and ops/ci/required.sh (following delegations inside the member) for
// what the required lane actually runs.
import fs from 'node:fs';
import path from 'node:path';
import { exists } from './family-lib.mjs';

export const GATE_CONTRACT = 'contracts/gate-contract.md';
export const DISPATCHER = 'scripts/ci-local.sh';
export const REQUIRED_LANE = 'ops/ci/required.sh';

/** The lanes every member owns, and the ops/ci script each delegates to. */
export const LANES = {
  required: 'ops/ci/required.sh',
  fast: 'ops/ci/fast.sh',
  security: 'ops/ci/security.sh',
  audit: 'ops/ci/audit.sh',
  gates: 'ops/ci/quality-gates.sh',
};
export const ALIASES = { all: 'gates' };
export const DEFAULT_LANE = 'required';

// A gate proves nothing it has to fetch first.
const DOWNLOADS = [
  [/\bcurl\b/, 'curl'],
  [/\bwget\b/, 'wget'],
  [/\bcargo\s+fetch\b/, 'cargo fetch'],
  [/\bcargo\s+update\b/, 'cargo update'],
  [/\bnpm\s+(?:install|ci)\b/, 'npm install'],
  [/\bpip3?\s+install\b/, 'pip install'],
  [/\brustup\s+(?:install|toolchain|component)\b/, 'rustup install'],
];
// Commands that compile the member and run its tests.
const PROOFS = [/\bcargo\s+test\b/, /\bcargo\s+nextest\b/, /\bnpm\s+test\b/, /\bnode\s+--test\b/];
const CARGO = /\bcargo\s+(?!fmt\b)([a-z-]+)((?:(?!\n|&&|\|\||;).)*)/g;
// `cargo fmt` reads source only; the lock flags do not apply to it.
const LOCK_EXEMPT = new Set(['fmt']);

const strip = text => text.replace(/(^|\s)#[^\n]*/g, '$1');

/**
 * The lane surface a dispatcher declares: the default lane, a lane -> body map
 * (one entry per pattern of a `case` arm), and whether it exits 2 on an
 * unknown lane.
 */
export function parseDispatcher(text) {
  const source = strip(text);
  const lanes = new Map();
  let unknownExitsTwo = false;
  for (const [, patterns, body] of source.matchAll(/^[ \t]*\(?([^()\n]+?)\)([\s\S]*?);;/gm)) {
    const names = patterns.split('|').map(name => name.trim()).filter(Boolean);
    if (names.includes('*')) {
      unknownExitsTwo = /\bexit\s+2\b/.test(body);
      continue;
    }
    for (const name of names) lanes.set(name, body.trim());
  }
  return {
    default: source.match(/\blane=["']?\$\{1:-([A-Za-z0-9_-]+)\}/)?.[1] ?? null,
    lanes,
    unknownExitsTwo,
  };
}

/** Every ops/ci script the required lane reaches, read once, concatenated. */
function requiredLaneBody(directory) {
  const seen = new Set();
  const queue = [REQUIRED_LANE];
  const parts = [];
  while (queue.length) {
    const relative = queue.shift();
    if (seen.has(relative) || seen.size > 16) continue;
    seen.add(relative);
    const file = path.join(directory, relative);
    if (!exists(file)) continue;
    const body = strip(fs.readFileSync(file, 'utf8'));
    parts.push(body);
    // A lane may put its proof in a sibling ops/ci script; follow those.
    for (const [, next] of body.matchAll(/\b(?:bash|sh|\/usr\/bin\/bash)\s+(ops\/ci\/[A-Za-z0-9._-]+\.sh)/g)) queue.push(next);
  }
  return { body: parts.join('\n'), files: [...seen] };
}

/** `{ repo, rule, detail }` per way a member checkout leaves the contract. */
export function gateViolations(name, directory) {
  const violations = [];
  // A lane repeating the same mistake on two lines is one violation to fix.
  const seen = new Set();
  const add = (rule, detail) => { if (!seen.has(`${rule}\0${detail}`)) { seen.add(`${rule}\0${detail}`); violations.push({ repo: name, rule, detail }); } };

  const dispatcher = path.join(directory, DISPATCHER);
  if (!exists(dispatcher)) {
    add('entrypoint', `missing ${DISPATCHER}`);
    return violations;
  }
  const surface = parseDispatcher(fs.readFileSync(dispatcher, 'utf8'));

  for (const [lane, script] of Object.entries(LANES)) {
    const body = surface.lanes.get(lane);
    if (body === undefined) { add('lanes', `${DISPATCHER} has no ${lane} lane`); continue; }
    if (!body.includes(script)) add('lanes', `${DISPATCHER} lane ${lane} does not delegate to ${script}`);
  }
  for (const [alias, lane] of Object.entries(ALIASES)) {
    const body = surface.lanes.get(alias);
    if (body === undefined) add('alias', `${DISPATCHER} has no ${alias} alias of ${lane}`);
    else if (body !== surface.lanes.get(lane)) add('alias', `${DISPATCHER} ${alias} is not an alias of ${lane}`);
  }
  if (surface.default !== DEFAULT_LANE) add('default', `${DISPATCHER} defaults to ${surface.default ?? '(none)'}, not ${DEFAULT_LANE}`);
  if (!surface.unknownExitsTwo) add('unknown-lane', `${DISPATCHER} does not exit 2 on an unknown lane`);

  if (!exists(path.join(directory, REQUIRED_LANE))) {
    add('required-strength', `missing ${REQUIRED_LANE}`);
    return violations;
  }
  const { body, files } = requiredLaneBody(directory);
  const where = files.length > 1 ? `${REQUIRED_LANE} (+${files.length - 1} delegated)` : REQUIRED_LANE;
  if (!PROOFS.some(proof => proof.test(body))) add('required-strength', `${where} never compiles the member or runs its tests`);
  for (const [, subcommand, rest] of body.matchAll(CARGO)) {
    if (LOCK_EXEMPT.has(subcommand)) continue;
    const missing = ['--locked', '--offline'].filter(flag => !rest.includes(flag));
    if (missing.length) add('required-offline', `${where}: cargo ${subcommand} without ${missing.join(' and ')}`);
  }
  for (const [pattern, label] of DOWNLOADS) if (pattern.test(body)) add('required-offline', `${where} downloads with ${label}`);
  return violations;
}

/** Every present member's violations, in manifest order. */
export function familyGateViolations(family) {
  const violations = [];
  for (const repo of family.repos) {
    if (!family.existing(repo)) continue;
    violations.push(...gateViolations(repo.name, family.path(repo)));
  }
  return violations;
}

/** The advisory (or blocking) report. Returns the violations it printed. */
export function reportGateContract(family, { blocking = false, log = console.log } = {}) {
  const violations = familyGateViolations(family);
  if (!violations.length) {
    log(`gate contract: ok (${GATE_CONTRACT})`);
    return violations;
  }
  const repos = new Set(violations.map(({ repo }) => repo));
  const head = `gate contract: ${violations.length} violation(s) in ${repos.size} member(s)${blocking ? '' : ' (advisory)'}`;
  const lines = violations.map(({ repo, rule, detail }) => `  ${repo}: [${rule}] ${detail}`);
  log([head, ...lines, `  see ${GATE_CONTRACT}`].join('\n'));
  return violations;
}
