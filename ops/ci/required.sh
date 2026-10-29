#!/usr/bin/env bash
# Required lane: the gate that must pass on every push.
# Runs the fast lane, which runs the family validator (split metadata, lock
# pins, action pinning posture) and the hub's own test suite, then checks the
# lock against the members: scripts/locked-family.sh fetches every member from
# the forge at its immutable family.lock tag and validates the committed trees
# with the same metadata/trust checks plus main ancestry. Per contracts/gate-contract.md the
# required lane has to run the member's tests; for this hub those three are the
# whole proof. The composition needs read access to the members on the forge.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

log "required lane: bash ops/ci/fast.sh"
bash ops/ci/fast.sh

# fast.sh validates the hub alone. The lock is only proven against the members
# themselves: fetch each real tag from the forge and validate its immutable
# tree and main ancestry without creating extra working copies.
log "required lane: bash scripts/locked-family.sh"
bash scripts/locked-family.sh
