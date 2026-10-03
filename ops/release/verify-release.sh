#!/usr/bin/env bash
# Verify a signed release inventory offline: complete inventory, checksums, the
# pinned public key, and a key signature on every asset. Needs no credentials.
# shellcheck source=ops/release/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dist='' tag=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dist) dist="${2:?}"; shift 2 ;;
    --tag) tag="${2:?}"; shift 2 ;;
    *) fail "unknown argument: $1" ;;
  esac
done
valid_release_tag "$tag" || fail 'a release tag vX.Y.Z is required'
[[ -d "$dist" ]] || fail "missing release inventory: $dist"
cosign="$(pinned_cosign)"
read -r key_name key_hash _ < <(node "$release_tooling/ops/release/release-keys.mjs" select "$tag") ||
  fail "no release key covers $tag"
[[ "$key_hash" =~ ^[0-9a-f]{64}$ && ! "$key_hash" =~ ^0+$ ]] || fail "release key $key_name is not provisioned"
node "$release_tooling/ops/release/verify-release-assets.mjs" "$dist" --tag "$tag"
[[ "$(sha256 "$dist/$key_name")" == "$key_hash" ]] || fail "$key_name does not match the installer pin"
count=0
for asset in "$dist"/*; do
  case "$asset" in *.sha256|*.cosign.bundle|*.pub) continue ;; esac
  name="$(basename "$asset")"
  [[ "$(cat "$asset.sha256")" == "$(sha256 "$asset")  $name" ]] || fail "checksum mismatch: $name"
  "$cosign" verify-blob "$asset" --bundle "$asset.cosign.bundle" --key "$dist/$key_name" \
    --insecure-ignore-tlog=true --offline=true >/dev/null 2>&1 || fail "signature verification failed: $name"
  count=$((count + 1))
done
printf 'Verified %d signed assets for %s against %s\n' "$count" "$tag" "$key_name"
