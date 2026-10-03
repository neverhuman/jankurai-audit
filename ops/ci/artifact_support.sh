#!/usr/bin/env bash
set -euo pipefail

workers="${1:-${WORKERS:-40}}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

out_dir="$repo_root/target/artifact-support"
rm -rf "$out_dir"
mkdir -p "$out_dir/logs" "$out_dir/receipts" "$out_dir/bundles" "$out_dir/signrail"

say() { printf '[artifact-support] %s\n' "$*" >&2; }

sha256_text() {
  printf '%s' "$1" | sha256sum | awk '{print "sha256:" $1}'
}

sha256_file_prefixed() {
  local path="$1"
  if [[ -f "$path" ]]; then
    sha256sum "$path" | awk '{print "sha256:" $1}'
  else
    printf 'sha256:%s' "$(printf '' | sha256sum | awk '{print $1}')"
  fi
}

current_sha() {
  git rev-parse HEAD
}

just_has() {
  command -v just >/dev/null 2>&1 || return 1
  [[ -f justfile || -f Justfile || -f .justfile ]] || return 1
  just --summary 2>/dev/null | tr ' ' '\n' | grep -qx "$1"
}

pick_ci_entrypoint() {
  if [[ -x ./ci-fast-push.sh ]]; then
    printf './ci-fast-push.sh --no-push --ci'
  elif [[ -f ops/ci/pr-ci.sh ]]; then
    printf 'bash ops/ci/pr-ci.sh'
  elif [[ -f scripts/ci-local.sh ]]; then
    printf 'bash scripts/ci-local.sh'
  elif just_has fast; then
    printf 'just fast'
  elif just_has check; then
    printf 'just check'
  elif just_has test; then
    printf 'just test'
  elif [[ -f Cargo.toml ]] && cargo nextest --version >/dev/null 2>&1; then
    printf 'cargo nextest run --workspace --no-fail-fast'
  elif [[ -f Cargo.toml ]]; then
    printf 'cargo test --workspace --no-fail-fast'
  elif [[ -f package.json ]]; then
    printf 'npm test'
  else
    return 1
  fi
}

run_ci() {
  local entrypoint="$1"
  say "ci-entrypoint: $entrypoint"
  case "$entrypoint" in
    './ci-fast-push.sh --no-push --ci')
      WORKERS="$workers" ./ci-fast-push.sh --no-push --ci
      ;;
    'bash ops/ci/pr-ci.sh')
      bash ops/ci/pr-ci.sh
      ;;
    'bash scripts/ci-local.sh')
      bash scripts/ci-local.sh
      ;;
    'just fast')
      just fast
      ;;
    'just check')
      just check
      ;;
    'just test')
      just test
      ;;
    'cargo nextest run --workspace --no-fail-fast')
      cargo nextest run --workspace --no-fail-fast
      ;;
    'cargo test --workspace --no-fail-fast')
      cargo test --workspace --no-fail-fast
      ;;
    'npm test')
      if [[ -f package-lock.json ]]; then
        npm ci --no-audit --no-fund
      fi
      npm test
      ;;
    *)
      printf 'unsupported CI entrypoint: %s\n' "$entrypoint" >&2
      return 91
      ;;
  esac
}

repo_slug_from_remote() {
  local url slug
  url="$(git remote get-url github 2>/dev/null || git remote get-url gh 2>/dev/null || git remote get-url origin 2>/dev/null || true)"
  slug="$(printf '%s' "$url" | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#^ssh://git@github.com/##; s#\.git$##')"
  if [[ "$slug" == */* && "$slug" != http:* && "$slug" != ssh:* ]]; then
    printf '%s' "$slug"
  else
    printf 'neverhuman/%s' "$(basename "$repo_root")"
  fi
}

write_json_files() {
  local entrypoint="$1" sha tree generated_at
  sha="$(current_sha)"
  tree="$(git rev-parse HEAD^{tree})"
  generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  python3 - "$out_dir" "$entrypoint" "$sha" "$tree" "$generated_at" "$workers" <<'PY'
import json
import pathlib
import subprocess
import sys

out_dir, entrypoint, sha, tree, generated_at, workers = sys.argv[1:7]
out = pathlib.Path(out_dir)
files = subprocess.check_output(["git", "ls-files"], text=True).splitlines()
(out / "context.json").write_text(json.dumps({
    "schema_version": 1,
    "generated_by": "ops/ci/artifact_support.sh",
    "repo": pathlib.Path.cwd().name,
    "sha": sha,
    "tree": tree,
    "generated_at": generated_at,
    "workers": int(workers),
    "ci_entrypoint": entrypoint,
}, indent=2, sort_keys=True) + "\n")
(out / "manifest.json").write_text(json.dumps({
    "schema_version": 1,
    "sha": sha,
    "tracked_file_count": len(files),
    "tracked_files": files,
}, indent=2, sort_keys=True) + "\n")
(out / "receipts" / "local-ci.json").write_text(json.dumps({
    "schema_version": 1,
    "sha": sha,
    "entrypoint": entrypoint,
    "status": "success",
}, indent=2, sort_keys=True) + "\n")
PY
}

bundle_evidence() {
  tar -czf "$out_dir/bundles/artifact-support-evidence.tar.gz" \
    -C "$out_dir" context.json manifest.json logs receipts
}

# Resolve the signrail CLI: explicit binary, then PATH, then a local Jeryu
# checkout named by JERYU_SOURCE_DIR, then a pinned install from the mirror.
run_signrail() {
  if [[ -n "${JERYU_SIGNRAIL_BIN:-}" ]]; then
    "$JERYU_SIGNRAIL_BIN" "$@"
  elif command -v jeryu-signrail >/dev/null 2>&1; then
    jeryu-signrail "$@"
  elif command -v jeryu_signrail >/dev/null 2>&1; then
    jeryu_signrail "$@"
  elif [[ -n "${JERYU_SOURCE_DIR:-}" && -f "${JERYU_SOURCE_DIR}/crates/jeryu-signrail/Cargo.toml" ]]; then
    cargo run -q --manifest-path "${JERYU_SOURCE_DIR}/crates/jeryu-signrail/Cargo.toml" -- "$@"
  else
    cargo install --locked --git https://github.com/neverhuman/jeryu jeryu-signrail
    jeryu-signrail "$@"
  fi
}

sign_bundle() {
  local bundle repo_slug sha version rollback_target tree_sha ci_ir_hash runner_rootfs_digest toolchain_material toolchain_digest cargo_lock_digest
  bundle="$out_dir/bundles/artifact-support-evidence.tar.gz"
  [[ -f "$bundle" ]] || { say "missing bundle: $bundle"; return 1; }
  [[ -n "${JERYU_SIGNRAIL_ED25519_SEED:-${SIGNRAIL_ED25519_SEED:-}}" ]] || {
    say "JERYU_SIGNRAIL_ED25519_SEED or SIGNRAIL_ED25519_SEED is required"
    return 1
  }
  repo_slug="${GITHUB_REPOSITORY:-$(repo_slug_from_remote)}"
  sha="$(current_sha)"
  version="${SIGNRAIL_RELEASE_VERSION:-$sha}"
  rollback_target="${SIGNRAIL_ROLLBACK_TARGET:-$(git rev-parse HEAD^ 2>/dev/null || printf '%s' "$sha")}"
  tree_sha="$(git rev-parse HEAD^{tree})"
  ci_ir_hash="$(sha256_file_prefixed "$out_dir/manifest.json")"
  runner_rootfs_digest="$(sha256_text "$(uname -a)|${ImageOS:-local}|${ImageVersion:-local}")"
  toolchain_material="$(rustc -Vv 2>/dev/null || true; cargo -V 2>/dev/null || true; node --version 2>/dev/null || true; npm --version 2>/dev/null || true)"
  toolchain_digest="$(sha256_text "$toolchain_material")"
  cargo_lock_digest="$(sha256_file_prefixed Cargo.lock)"
  run_signrail sign-release \
    --artifact "$bundle" \
    --repo "$repo_slug" \
    --sha "$sha" \
    --tree-sha "$tree_sha" \
    --version "$version" \
    --rollback-target "$rollback_target" \
    --test-status "normal-ci-and-artifact-support-passed" \
    --store-root "${SIGNRAIL_STORE_ROOT:-${HOME}/.local/share/jeryu/signrail}" \
    --out-dir "$out_dir/signrail" \
    --stage local \
    --stage dev-canary \
    --stage prod \
    --ci-ir-hash "$ci_ir_hash" \
    --runner-rootfs-digest "$runner_rootfs_digest" \
    --toolchain-digest "$toolchain_digest" \
    --cargo-lock-digest "$cargo_lock_digest"
}

entrypoint="$(pick_ci_entrypoint)" || { say "no supported CI entrypoint"; exit 91; }
if run_ci "$entrypoint" >"$out_dir/logs/ci.log" 2>&1; then
  write_json_files "$entrypoint"
  bundle_evidence
  sign_bundle
  say "artifact support evidence ready at $out_dir"
else
  rc=$?
  say "CI failed; log: $out_dir/logs/ci.log"
  exit "$rc"
fi
