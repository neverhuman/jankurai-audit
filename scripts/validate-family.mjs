import { validateTree } from './family-tree-validation.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Family } from './family-model.mjs';
import { clean, exists, gitText, readToml } from './family-lib.mjs';
import { validateAuditorPin } from './auditor-pin.mjs';
import { validateVendoredTrust } from './vendored-trust.mjs';
import { reportGateContract } from './gate-contract.mjs';
import { pinsOffMain } from './pins-on-main.mjs';

try {
  const family = new Family(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const checkouts = process.argv.includes('--checkouts');
  const hubOnly = process.argv.includes('--hub-only');
  if (hubOnly && (checkouts || process.argv.includes('--pins-on-main'))) throw new Error('--hub-only cannot be combined with locked checkout validation');
  // The hub fast lane must not inspect unrelated runner sibling revisions.
  // The required lane separately proves every committed lock input.
  if (hubOnly) family.repos = family.repos.filter(repo => repo.name === 'jankurai');
  // The gate contract is advisory until the family's lane surfaces converge, so
  // it is off by default and never fails a run unless asked to.
  const blockingGate = process.argv.includes('--gate-contract-blocking');
  const gateContract = blockingGate || process.argv.includes('--gate-contract');
  readToml(path.join(family.hub, 'Cargo.lock'));
  validateAuditorPin(family);
  validateVendoredTrust(family);
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
  // Opt-in: every pin must also be merged on its member's main (see pins-on-main.mjs).
  if (process.argv.includes('--pins-on-main')) {
    if (!checkouts) throw new Error('--pins-on-main needs --checkouts');
    const off = pinsOffMain(family);
    if (off.length) throw new Error(`${off.length} pin(s) not on main:\n  ${off.map(({ repo, detail }) => `${repo}: ${detail}`).join('\n  ')}`);
  }
  if (gateContract) {
    const violations = reportGateContract(family, { blocking: blockingGate });
    if (blockingGate && violations.length) throw new Error(`gate contract: ${violations.length} violation(s)`);
  }
  console.log('validate-family: ok');
} catch (error) { console.error(`validate-family: ${error.message}`); process.exitCode = 1; }
