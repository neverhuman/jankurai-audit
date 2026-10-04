import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { gateViolations, familyGateViolations, parseDispatcher, reportGateContract } from './gate-contract.mjs';

/** A member checkout on disk: `files` is relative path -> contents. */
function member(files, fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-contract-')));
  try {
    for (const [relative, body] of Object.entries(files)) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    }
    return fn(root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const rules = violations => violations.map(({ rule }) => rule);
const details = violations => violations.map(({ repo, rule, detail }) => `${repo}: [${rule}] ${detail}`).join('\n');

// A member that holds contracts/gate-contract.md in full.
const COMPLIANT = {
  'scripts/ci-local.sh': `#!/usr/bin/env bash
# Local entry point for the CI lanes.
set -euo pipefail
cd "$(dirname "\${BASH_SOURCE[0]}")/.."

lane="\${1:-required}"
case "$lane" in
  required) bash ops/ci/required.sh ;;
  fast)     bash ops/ci/fast.sh ;;
  security) bash ops/ci/security.sh ;;
  audit)    bash ops/ci/audit.sh ;;
  gates|all) bash ops/ci/quality-gates.sh ;;
  *) echo "usage: $0 {required|fast|security|audit|gates|all}" >&2; exit 2 ;;
esac
`,
  'ops/ci/required.sh': `#!/usr/bin/env bash
set -euo pipefail
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked --offline -- -D warnings
cargo test --workspace --locked --offline
`,
};

test('a member that holds the contract reports nothing', () => {
  member(COMPLIANT, root => {
    const violations = gateViolations('jankurai-example', root);
    assert.deepEqual(violations, [], details(violations));
  });
});

test('the proof may live in a delegated ops/ci script', () => {
  member({ ...COMPLIANT,
    'ops/ci/required.sh': '#!/usr/bin/env bash\nset -euo pipefail\nbash ops/ci/fast.sh\n',
    'ops/ci/fast.sh': '#!/usr/bin/env bash\ncargo test --workspace --locked --offline\n' },
  root => {
    const violations = gateViolations('jankurai-example', root);
    assert.deepEqual(violations, [], details(violations));
  });
});

// jankurai-deploy as of 2026-10-03: one metadata-only lane, `bash -n` only.
const DEPLOY = {
  'scripts/ci-local.sh': `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "\${BASH_SOURCE[0]}")/.."

lane="\${1:-required}"
case "$lane" in
  required) bash ops/ci/required.sh ;;
  *) echo "usage: $0 {required}" >&2; exit 2 ;;
esac
`,
  'ops/ci/required.sh': `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "\${BASH_SOURCE[0]}")/../.."
for script in scripts/*.sh ops/ci/*.sh; do bash -n "$script"; done
`,
};

test('a member with one bash -n lane is reported for every missing lane and for strength', () => {
  member(DEPLOY, root => {
    const violations = gateViolations('jankurai-deploy', root);
    const report = details(violations);
    for (const lane of ['fast', 'security', 'audit', 'gates']) {
      assert.match(report, new RegExp(`\\[lanes\\] scripts/ci-local\\.sh has no ${lane} lane`), report);
    }
    assert.match(report, /\[alias\] scripts\/ci-local\.sh has no all alias of gates/, report);
    assert.match(report, /\[required-strength\] ops\/ci\/required\.sh never compiles the member or runs its tests/, report);
    // Its default and its exit 2 are right, so neither is named.
    assert.ok(!rules(violations).includes('default'), report);
    assert.ok(!rules(violations).includes('unknown-lane'), report);
  });
});

// jankurai-tools-proof as of 2026-10-03: a real suite, but no --offline.
test('a required lane that compiles but may download is reported for offline only', () => {
  member({ ...DEPLOY,
    'scripts/ci-local.sh': DEPLOY['scripts/ci-local.sh'].replace('  required)', '  security) bash ops/ci/security.sh ;;\n  required)'),
    'ops/ci/required.sh': `#!/usr/bin/env bash
set -euo pipefail
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked --offline -- -D warnings
cargo test --workspace --locked
` },
  root => {
    const violations = gateViolations('jankurai-tools-proof', root);
    const report = details(violations);
    assert.match(report, /\[required-offline\] ops\/ci\/required\.sh: cargo test without --offline/, report);
    // `cargo fmt` reads source, so the lock flags are not asked of it.
    assert.doesNotMatch(report, /cargo fmt/, report);
    assert.doesNotMatch(report, /never compiles/, report);
  });
});

// jankurai-tools-tui as of 2026-10-03: `quality-gates` instead of `gates|all`.
test('a member that renames the gates lane is reported for the lane and the alias', () => {
  member({ ...COMPLIANT,
    'scripts/ci-local.sh': COMPLIANT['scripts/ci-local.sh'].replace('gates|all)', 'quality-gates)'),
    'ops/ci/required.sh': '#!/usr/bin/env bash\ncargo metadata --no-deps --format-version 1 >/dev/null\ncargo test --workspace --locked\n' },
  root => {
    const report = details(gateViolations('jankurai-tools-tui', root));
    assert.match(report, /\[lanes\] scripts\/ci-local\.sh has no gates lane/, report);
    assert.match(report, /\[alias\] scripts\/ci-local\.sh has no all alias of gates/, report);
    assert.match(report, /cargo metadata without --locked and --offline/, report);
    assert.match(report, /cargo test without --offline/, report);
  });
});

test('the same mistake on two lines is reported once', () => {
  member({ ...COMPLIANT, 'ops/ci/required.sh': '#!/usr/bin/env bash\ncargo metadata --no-deps >/dev/null\ncargo metadata --offline >/dev/null\ncargo test --workspace --locked --offline\n' },
    root => assert.deepEqual(gateViolations('jankurai-example', root).map(({ detail }) => detail), [
      'ops/ci/required.sh: cargo metadata without --locked and --offline',
      'ops/ci/required.sh: cargo metadata without --locked',
    ]));
});

test('the default lane must be required, not all', () => {
  member({ ...COMPLIANT, 'scripts/ci-local.sh': COMPLIANT['scripts/ci-local.sh'].replace('${1:-required}', '${1:-all}') },
    root => assert.match(details(gateViolations('jankurai-example', root)), /\[default\] scripts\/ci-local\.sh defaults to all, not required/));
});

test('an unknown lane must exit 2, not 1', () => {
  member({ ...COMPLIANT, 'scripts/ci-local.sh': COMPLIANT['scripts/ci-local.sh'].replace('exit 2', 'exit 1') },
    root => assert.match(details(gateViolations('jankurai-example', root)), /\[unknown-lane\] scripts\/ci-local\.sh does not exit 2/));
});

test('a lane that does not delegate to its ops/ci script is reported', () => {
  member({ ...COMPLIANT, 'scripts/ci-local.sh': COMPLIANT['scripts/ci-local.sh'].replace('fast)     bash ops/ci/fast.sh', 'fast)     cargo check --locked --offline') },
    root => assert.match(details(gateViolations('jankurai-example', root)), /lane fast does not delegate to ops\/ci\/fast\.sh/));
});

test('a download in the required lane is reported', () => {
  member({ ...COMPLIANT, 'ops/ci/required.sh': `${COMPLIANT['ops/ci/required.sh']}curl -sSfL https://example.invalid/tool -o target/tool\n` },
    root => assert.match(details(gateViolations('jankurai-example', root)), /downloads with curl/));
});

test('a missing entrypoint is the only violation reported', () => {
  member({ 'ops/ci/required.sh': 'cargo test --locked --offline\n' },
    root => assert.deepEqual(gateViolations('jankurai-example', root), [{ repo: 'jankurai-example', rule: 'entrypoint', detail: 'missing scripts/ci-local.sh' }]));
});

test('a commented-out lane does not count as declared', () => {
  member({ ...COMPLIANT, 'scripts/ci-local.sh': COMPLIANT['scripts/ci-local.sh'].replace('  audit)', '  # audit)') },
    root => assert.match(details(gateViolations('jankurai-example', root)), /has no audit lane/));
});

test('the dispatcher parser reads the default, the arms and the unknown-lane exit', () => {
  const surface = parseDispatcher(COMPLIANT['scripts/ci-local.sh']);
  assert.equal(surface.default, 'required');
  assert.equal(surface.unknownExitsTwo, true);
  assert.deepEqual([...surface.lanes.keys()], ['required', 'fast', 'security', 'audit', 'gates', 'all']);
});

/** A two-member family whose checkouts both exist. */
function family(root, members) {
  return {
    hub: path.join(root, 'jankurai'),
    repos: Object.keys(members).map(name => ({ name, path: name })),
    path: repo => path.join(root, repo.path),
    existing: () => true,
  };
}

test('the family report names the failing member and skips the compliant one', () => {
  const members = { 'jankurai-good': COMPLIANT, 'jankurai-bad': DEPLOY };
  const files = {};
  for (const [name, member] of Object.entries(members)) for (const [relative, body] of Object.entries(member)) files[`${name}/${relative}`] = body;
  member(files, root => {
    const violations = familyGateViolations(family(root, members));
    assert.ok(violations.length > 0);
    assert.deepEqual([...new Set(violations.map(({ repo }) => repo))], ['jankurai-bad']);
    const lines = [];
    const printed = reportGateContract(family(root, members), { log: line => lines.push(line) });
    assert.equal(printed.length, violations.length);
    assert.match(lines.join('\n'), /gate contract: \d+ violation\(s\) in 1 member\(s\) \(advisory\)/);
    assert.match(lines.join('\n'), /see contracts\/gate-contract\.md/);
  });
});

test('a compliant family reports ok', () => {
  member({ 'jankurai-good/scripts/ci-local.sh': COMPLIANT['scripts/ci-local.sh'], 'jankurai-good/ops/ci/required.sh': COMPLIANT['ops/ci/required.sh'] },
    root => {
      const lines = [];
      assert.deepEqual(reportGateContract(family(root, { 'jankurai-good': COMPLIANT }), { log: line => lines.push(line) }), []);
      assert.match(lines.join('\n'), /gate contract: ok/);
    });
});
