#!/usr/bin/env bash
# Required lane: the gate that must pass on every push.
# Delegates to the fast lane, which runs the family validator (split metadata,
# lock pins, action pinning posture) and the hub's own test suite. Per
# contracts/gate-contract.md the required lane has to run the member's tests,
# and for this hub that pair is the whole proof, so it is one script.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

log "required lane: bash ops/ci/fast.sh"
bash ops/ci/fast.sh
