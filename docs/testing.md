# jankurai Hub Testing

This document is the proof and observability surface for the jankurai hub. It
describes how every change is proven, how failures surface as agent-readable
repair hints, and where the proof lanes live.

## Proof lanes

The hub is validated by deterministic, hermetic lanes runnable from the repo
root. The same `ops/ci/<lane>.sh` commands run locally and in forge CI on our
own hosts; GitHub is a publishing mirror and runs no workflows.

| Lane | Command | Proves |
| --- | --- | --- |
| `fast` | `bash scripts/ci-local.sh fast` | split metadata, lock pins, branch deps, cross-repo path deps, `action.yml` pinning, and the complete hub test suite |
| `required` | `bash scripts/ci-local.sh required` | fast plus a fresh locked family with every pin on its member's main |
| `security` | `gitleaks detect` + family-lock review | no committed secrets, no supply-chain drift |
| `audit` | `jankurai audit . --json .jankurai/repo-score.json --md .jankurai/repo-score.md` | repo passes the jankurai standard |
| `check` | `fast` + `security` + `audit` | the full local gate |
| `demo` | `npm run demo:verify` | committed README and 1080p GIFs stay lossless, exact-palette, and under 50 MB |

Every real top-level path is routed to a proof command in
[`agent/test-map.json`](../agent/test-map.json). The narrowest agent loop is
`just fast`.

## Repair receipts and telemetry

Failures are never opaque. Each lane emits a structured, agent-readable receipt
so the next agent can repair locally without re-deriving context:

- `scripts/validate-family.sh` prints `validate-family: <reason>` and exits
  non-zero with the exact failing pin, manifest entry, or unpinned `action.yml` step.
- The audit lane writes both `.jankurai/repo-score.json` and
  `.jankurai/repo-score.md`. The JSON `findings[]` array carries, for every
  finding, a typed repair surface: `rule_id`, `path`, `problem`, `agent_fix`,
  `evidence`, `rerun_command`, and `docs_url`. Agents route off these fields.

## Typed exception and repair-hint surface

When a lane fails, it surfaces a typed repair hint rather than a bare error.
Each hint names its purpose, the reason it fired, the common fixes, and a local
docs URL so the next rerun is local:

```json
{
  "purpose": "family lock pin must resolve to an immutable tag and commit",
  "reason": "family.lock entry for <repo> points at a branch, not a tag",
  "common_fixes": [
    "repin the member to its release tag and commit SHA in family.lock",
    "run scripts/validate-family.sh to confirm the pin resolves"
  ],
  "docs_url": "docs/release.md#release-automation",
  "repair_hint": "branch dependencies are never released; pin to an immutable tag",
  "rerun_command": "bash scripts/validate-family.sh"
}
```

The same pattern governs audit findings: read `agent_fix` and `rerun_command`
from `.jankurai/repo-score.json`, apply the fix, and rerun the named lane.

## Exceptions

Deviations from the standard are bounded, dated, owned waivers recorded as data,
not prose. See [`docs/exceptions.md`](exceptions.md) for how to request, record,
and review an exception. Secret leakage, committed cross-repo path
dependencies, branch-pinned release inputs, and hand-edits to generated zones
are never excepted.

## Pre-handoff checklist

Run `bash scripts/ci-local.sh required` (equivalently `just required`) before
handing off any change, then `just check` before cutting a release.

## Iteration and resource limits

`just test-name 'installer'` runs matching Node tests during a narrow repair;
it does not replace the full required gate. `npm test` limits test-file
concurrency to four processes, including on large build hosts. Reuse the
checkout's `target/` build cache. `.fusion/` is an optional generated local
workspace, not an artifact required in a fresh source checkout.

The release budget is one build per target per candidate, with a quota of one
active build per host. There are no paid model/API calls in this hub's gate;
the spend cap for introducing them is zero without a separate owner decision.
Run long release builds through `timeout --signal=TERM --kill-after=60s 2h`
(see the release checklist). The stop condition is a nonzero command exit,
timeout, failed integrity check, or insufficient disk. Do not automatically
retry: inspect and retain the failed log before starting a corrected candidate.
Ctrl-C is the operator kill switch for a foreground run; the timeout terminates
the process group when the operator is away. Do not launch a replacement while
the original build or its container is still running.
