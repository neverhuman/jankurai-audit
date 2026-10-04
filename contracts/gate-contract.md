# Family gate contract

Status: active
Owner: Jankurai maintainers
Last reviewed: 2026-10-04
Applies to: every repository in `repos.manifest.toml`

Every member's `AGENTS.md` tells a contributor to run `bash scripts/ci-local.sh
required` before handing off, but until this contract nothing said which lanes
that dispatcher owns or what `required` has to prove. The fleet gate analysis of
2026-10-03 found the result: members with one metadata-only lane, members whose
`required` only ran `bash -n`, members missing `fast`, `security` or `audit`
altogether, and two different defaults (`required` and `all`). A gate that means
something different in each repository cannot be relied on by any of them.

This file is that definition. `node scripts/validate-family.mjs --gate-contract`
checks each present member against it; see "Enforcement" below.

## Entrypoint

- The one local entrypoint is `bash scripts/ci-local.sh <lane>`, run from any
  directory inside the checkout.
- `scripts/ci-local.sh` is a dispatcher and nothing else: each lane delegates to
  `ops/ci/<lane>.sh`, which is the same script the forge CI host runs. A lane
  that inlines its work in the dispatcher drifts from CI by construction.

## Lanes

| Lane | Delegates to | Proves |
| --- | --- | --- |
| `required` | `ops/ci/required.sh` | the gate below: the member builds and its tests pass |
| `fast` | `ops/ci/fast.sh` | the shortest useful proof, for an edit loop |
| `security` | `ops/ci/security.sh` | the member's security posture checks |
| `audit` | `ops/ci/audit.sh` | the governed Jankurai audit of the member |
| `gates` | `ops/ci/quality-gates.sh` | the member's quality gates |

- `all` is an alias of `gates`, declared in the same `case` arm (`gates|all)`).
  It exists because half the family already types `all`; it is an alias, never a
  sixth lane with its own meaning.
- A member may add lanes of its own (`drift`, `tool-adoption`, ...). Extra lanes
  are never a violation; a missing one from the table always is.

## Default and exit codes

- `bash scripts/ci-local.sh` with no argument runs `required`. `required` is the
  lane the family asks for by name everywhere, so the bare command must be it
  and not the slower `all`.
- An unrecognised lane prints a `usage:` line naming the lanes to stderr and
  exits **2**. Exit 1 is a lane that ran and failed; 2 is a lane that does not
  exist, and a caller has to be able to tell those apart.

## What `required` must prove

`required` is the only lane other repositories, the lock and the landing worker
depend on, so its strength is part of the contract:

- It **compiles the member and runs its tests**. For a Rust member that means a
  `cargo test` (or a `cargo build`/`cargo clippy` plus a test run); for a
  JavaScript member, `npm test` or `node --test`. Syntax checks (`bash -n`),
  formatting, metadata reads and lint alone do not qualify — none of them would
  notice a member that stopped building.
- It **runs offline**: every `cargo` invocation passes `--locked` and
  `--offline`, so the lane proves the committed lock rather than whatever the
  registry serves today.
- It **downloads nothing**. No `curl`, `wget`, `cargo fetch`, `cargo update`,
  `npm install`/`npm ci`, `pip install`, or `rustup` install in the lane. A gate
  that needs the network is not a gate; it is a weather report.
- `required` may delegate to other `ops/ci/*.sh` scripts in the same member, and
  the proof may live in any of them. The contract is about what the lane runs in
  total, not about which file holds the command.

## Enforcement

```bash
node scripts/validate-family.mjs --gate-contract            # advisory: reports, stays green
node scripts/validate-family.mjs --gate-contract-blocking   # blocking: reports and fails
```

The check parses each present member's `scripts/ci-local.sh` and
`ops/ci/required.sh` (following delegations inside the member) and reports one
line per violation, naming the repository, the rule and what it found.

It is advisory first on purpose: on 2026-10-03 most of the family violated some
part of this file, and `jankurai-deploy`, `jankurai-tools-proof` and
`jankurai-tools-tui` violated the `required`-strength rule. Making it blocking
before those are fixed would only mean nobody could land the fixes. Flip the
default to blocking once the advisory report is empty.

The default `validate-family` run does not perform this check, so the family's
existing gate stays green while the lane surfaces converge.
