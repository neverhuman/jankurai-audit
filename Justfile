# jankurai hub root command surface.
# One-command setup and validation lanes for agents and CI.
# This repo is the thin public hub: it carries the installer, GitHub Action,
# family manifest, lockfile, and the local fusion script. Every lane below is
# deterministic, hermetic, and runnable from the repo root. The same commands
# run in CI via ops/ci/<lane>.sh so local and CI execution match exactly.

# Default: list available lanes.
default:
    @just --list

# One-command bootstrap: make the local CI scripts executable and resolve the
# family manifest against the lockfile so the hub is ready to validate.
setup:
    bash scripts/family.sh setup

pull:
    bash scripts/family.sh pull

build:
    bash scripts/family.sh build

status:
    bash scripts/family.sh status

# Aliases so `just install` and `just bootstrap` also resolve to setup.
install: setup

bootstrap: setup

# Verify the committed README preview and 1080p audit GIFs.
demo:
    npm run demo:verify

# Deterministic fast lane: the narrowest proof loop for agent iteration.
# Validates required split metadata, Jeryu mirror config, lockfile pins, branch
# dependencies, committed cross-repo path dependencies, and action pinning.
fast:
    bash scripts/validate-family.sh

# Run the full local check: fast lane, security scan, and self-audit.
check:
    bash scripts/family.sh check

# Verify is an alias of check for agents that look for a `verify` lane.
verify: check

# Run the hub validation suite (alias of the fast lane).
test:
    bash scripts/validate-family.sh

# Security lane: secret scanning, supply-chain SBOM, and family lock review.
# gitleaks scans the tracked tree for committed secrets; syft generates a
# CycloneDX SBOM from the family manifest/lock supply-chain surface; and the
# manifest scan verifies every
# family lock pin resolves to an immutable tag and commit (this hub's
# dependency-audit surface, since no Cargo.toml/package.json is shipped).
security:
    gitleaks detect --source . --no-banner --redact
    syft scan dir:. -o cyclonedx-json=target/jankurai/security/sbom.json
    bash scripts/validate-family.sh

# Jankurai self-audit lane: writes the repo-score artifacts that CI uploads.
audit:
    .fusion/target/debug/jankurai audit . --no-score-history --json .jankurai/repo-score.json --md .jankurai/repo-score.md

# Report every present member whose lane surface leaves contracts/gate-contract.md.
# Advisory: it prints violations and stays green. Append `-blocking` to fail.
gate-contract:
    bash scripts/validate-family.sh --gate-contract

# Print the declared hub version.
versions:
    cat VERSION

# Durable paired-lock recovery: inspect journal without npm bootstrap.
recover-inspect:
    bash scripts/family.sh recover inspect --json

recover-finish:
    bash scripts/family.sh recover finish

recover-rollback:
    bash scripts/family.sh recover rollback
