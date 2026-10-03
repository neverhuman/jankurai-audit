#!/usr/bin/env bash
# Security lane: secret scanning, supply-chain SBOM, and action lint.
# gitleaks scans the tracked tree for committed secrets; syft generates a
# CycloneDX SBOM from the family manifest/lock supply-chain surface; zizmor
# lints the shipped composite action.yml; and the family-manifest scan
# verifies every family.lock pin resolves to an immutable tag and commit, which
# covers immutable component inputs; npm audit checks the hub's TOML parser.
# The same lane runs locally via `just security`.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

mkdir -p target/jankurai/security

log "security lane: gitleaks detect + syft sbom + zizmor action.yml + family lock review"
gitleaks detect --source . --no-banner --redact
syft scan dir:. -o cyclonedx-json=target/jankurai/security/sbom.json
zizmor --no-progress action.yml
npm audit --audit-level=high
bash scripts/validate-family.sh
