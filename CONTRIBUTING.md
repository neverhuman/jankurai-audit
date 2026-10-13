# Contributing To Jankurai

Jankurai is a Rust CLI and agent-native standard workspace. Contributions should keep the project deterministic, locally verifiable, and conservative about writes to user repositories.

## Setup

Prerequisites:

- Rust stable with `cargo`
- `just`
- Node.js 22 and `npm` for the UX QA package
- `latexmk` for paper validation

Install dependencies and run the fast lane:

```bash
npm ci
cargo test -p jankurai --test command_surface_smoke
just fast
```

## Before Editing

Read these files first:

```text
AGENTS.md
agent/JANKURAI_STANDARD.md
agent/owner-map.json
agent/test-map.json
agent/generated-zones.toml
agent/standard-version.toml
```

Rules that matter for most pull requests:

- Keep new files inside the repository root.
- Treat `reference/` as read-only source material.
- Do not hand-edit generated artifacts unless the generator or source changes.
- Add owner-map and test-map routes for new public paths.
- Prefer narrow changes over broad refactors.
- Do not add silent fallbacks, disabled tests, or unbounded agent permissions.

## Proof Lanes

Use the smallest credible proof lane for changed paths. Common commands:

```bash
cargo fmt --all
cargo test -p jankurai --test command_surface_smoke
cargo test -p jankurai
just fast
just score
git diff --check
```

For paper work:

```bash
just paper
```

For UX QA work:

```bash
just ux-qa
```

For high-risk security or dependency changes:

```bash
just security
```

## Compatibility

Public CLI commands, report schemas, and agent-facing file contracts are compatibility surfaces. A change that alters them should include one of:

- a compatibility-preserving implementation,
- a schema/version update with migration notes,
- or a commit subject and `Todo:` trailer that call out the breaking change for the release notes generated from commits since the last release.

## Pull Request Expectations

Every pull request should include:

- what changed and why,
- changed paths,
- validation commands run,
- generated artifacts or receipts produced,
- known residual risk.

Keep generated output in declared zones. If a validation command fails, include the failing command and the reason you believe the failure is related or unrelated.
