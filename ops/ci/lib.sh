#!/usr/bin/env bash
# Shared CI helper module sourced by every ops/ci/<lane>.sh script.
# Single source of truth for tool version pins and artifact assertions so
# local runs and forge CI execute the exact same commands.
set -euo pipefail

# Resolve the repository root regardless of where a lane is invoked from.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export REPO_ROOT

# Pinned tool versions. Lanes read these so CI and local environments match.
export GITLEAKS_VERSION="${GITLEAKS_VERSION:-8.18.4}"

# log <message> -- emit a structured progress line.
log() {
  printf '[ci] %s\n' "$*"
}

# require_tool <binary> -- fail fast with an actionable message when a pinned
# tool is missing from PATH so local parity gaps surface before the lane runs.
require_tool() {
  local tool="$1"
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf '[ci] missing required tool: %s\n' "$tool" >&2
    return 1
  fi
}

# assert_artifact <path> -- confirm a lane produced the artifact it promised.
assert_artifact() {
  local artifact="$1"
  if [ ! -e "$REPO_ROOT/$artifact" ]; then
    printf '[ci] expected artifact missing: %s\n' "$artifact" >&2
    return 1
  fi
  log "artifact present: $artifact"
}
