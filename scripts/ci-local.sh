#!/usr/bin/env bash
# Local CI runner: dispatches to ops/ci/<lane>.sh so a green local run means a
# green CI run. Forge CI on our own hosts calls the same ops/ci/<lane>.sh scripts.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

lane="${1:-required}"
case "$lane" in
  required) bash ops/ci/required.sh ;;
  fast)     bash ops/ci/fast.sh ;;
  security) bash ops/ci/security.sh ;;
  audit)    bash ops/ci/audit.sh ;;
  gates|all) bash ops/ci/quality-gates.sh ;;
  *) echo "usage: $0 {required|fast|security|audit|gates|all}" >&2; exit 2 ;;
esac
