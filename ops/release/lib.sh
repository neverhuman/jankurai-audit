#!/usr/bin/env bash
# Shared helpers for the server-side release scripts in ops/release.
set -euo pipefail
# shellcheck disable=SC2034 # used by the scripts that source this file
release_tooling="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Pinned cosign, identical to the installer's verifier (sha256 of the upstream binary).
cosign_linux_amd64=4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71
cosign_darwin_arm64=5cf948c2f4dfe59687bdd0b8523709067383e03982cc543475c8a7dc70e92a76

fail() { printf '%s: %s\n' "$(basename "$0")" "$*" >&2; exit 1; }
note() { printf '==> %s\n' "$*" >&2; }

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d ' ' -f 1
  else shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

valid_release_tag() { [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; }

host_target() {
  case "$(uname -s)/$(uname -m)" in
    Linux/x86_64) printf 'x86_64-unknown-linux-gnu\n' ;;
    Darwin/arm64) printf 'aarch64-apple-darwin\n' ;;
    *) return 1 ;;
  esac
}

file_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
file_owner() { stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1"; }

# A secret file must be a regular, non-linked file owned by us and private to us.
require_private_file() {
  local file="$1" label="$2" mode
  [[ -n "$file" ]] || fail "$label path is empty"
  [[ ! -L "$file" ]] || fail "$label must not be a symlink: $file"
  [[ -f "$file" ]] || fail "$label is missing or not a regular file: $file"
  [[ "$(file_owner "$file")" == "$(id -u)" ]] || fail "$label is not owned by the current user: $file"
  mode="$(file_mode "$file")"
  (( (8#$mode & 8#077) == 0 )) || fail "$label is readable or writable by group/others (mode $mode); chmod 600 it: $file"
}

# A private key must also live outside every Git work tree.
require_outside_repository() {
  local file="$1" label="$2"
  if git -C "$(dirname "$file")" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    fail "$label must live outside any Git repository: $file"
  fi
}

# Resolve cosign and insist on the exact pinned binary for this host.
pinned_cosign() {
  local cosign="${COSIGN:-$(command -v cosign || true)}" expected
  [[ -n "$cosign" && -x "$cosign" ]] || fail 'cosign 3.1.3 is required (set COSIGN=/path/to/cosign)'
  case "$(host_target || true)" in
    x86_64-unknown-linux-gnu) expected="$cosign_linux_amd64" ;;
    aarch64-apple-darwin) expected="$cosign_darwin_arm64" ;;
    *) fail 'unsupported signing host' ;;
  esac
  [[ "$(sha256 "$cosign")" == "$expected" ]] || fail "cosign at $cosign is not the pinned upstream v3.1.3 binary"
  printf '%s\n' "$cosign"
}
