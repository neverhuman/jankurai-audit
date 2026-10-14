#!/usr/bin/env bash
# Required lane: the gate that must pass on every push.
# Runs the fast lane, which runs the family validator (split metadata, lock
# pins, action pinning posture) and the hub's own test suite, then checks the
# lock against the members: scripts/locked-family.sh composes every member from
# the forge at its family.lock pin and runs validate-family --checkouts
# --pins-on-main on that composition. Per contracts/gate-contract.md the
# required lane has to run the member's tests; for this hub those three are the
# whole proof. The composition needs read access to the members on the forge.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

log "required lane: bash ops/ci/fast.sh"
bash ops/ci/fast.sh

# fast.sh validates the hub alone. The lock is only proven against the members
# themselves: compose each one from the forge at its family.lock pin and run
# validate-family --checkouts --pins-on-main on that composition.
log "required lane: bash scripts/locked-family.sh"
bash scripts/locked-family.sh
