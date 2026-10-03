#!/usr/bin/env bash
# Sign a built release inventory with the release key we hold (cosign, offline).
#
#   JANKURAI_RELEASE_SIGNING_KEY=<path to cosign.key> \
#   JANKURAI_RELEASE_SIGNING_PASSWORD_FILE=<0600 file> (or COSIGN_PASSWORD) \
#   ops/release/sign-release.sh --dist target/release-dist/vX.Y.Z --tag vX.Y.Z
#
# Every asset gets <asset>.cosign.bundle: a Sigstore bundle holding only the key
# signature, verifiable offline with the pinned public key. Nothing is sent to
# Rekor unless JANKURAI_RELEASE_TLOG_UPLOAD=1 (an explicit owner opt-in).
# shellcheck source=ops/release/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dist='' tag=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dist) dist="${2:?}"; shift 2 ;;
    --tag) tag="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done
valid_release_tag "$tag" || fail 'a release tag vX.Y.Z is required'
[[ -d "$dist" ]] || fail "missing release inventory: $dist"
dist="$(cd "$dist" && pwd)"

key="${JANKURAI_RELEASE_SIGNING_KEY:-}"
[[ -n "$key" ]] || fail 'set JANKURAI_RELEASE_SIGNING_KEY to the private key file'
require_private_file "$key" 'release signing key'
require_outside_repository "$key" 'release signing key'
case "$(cd "$(dirname "$key")" && pwd)/" in "$dist"/*) fail 'the signing key must not live inside the release inventory' ;; esac
if [[ -z "${COSIGN_PASSWORD+set}" ]]; then
  password_file="${JANKURAI_RELEASE_SIGNING_PASSWORD_FILE:-}"
  [[ -n "$password_file" ]] || fail 'set COSIGN_PASSWORD or JANKURAI_RELEASE_SIGNING_PASSWORD_FILE'
  require_private_file "$password_file" 'signing password file'
  IFS= read -r COSIGN_PASSWORD < "$password_file" || true
  [[ -n "$COSIGN_PASSWORD" ]] || fail 'empty signing password file'
fi
export COSIGN_PASSWORD
cosign="$(pinned_cosign)"

# The key must be the one the installer pins for this tag.
read -r key_name key_hash public_key < <(node "$release_tooling/ops/release/release-keys.mjs" pinned "$tag") ||
  fail "no provisioned release key covers $tag"
derived="$(mktemp)"
trap 'rm -f "$derived"' EXIT
"$cosign" public-key --key "$key" > "$derived" 2>/dev/null || fail 'cannot read the signing key (wrong password?)'
cmp -s "$derived" "$public_key" || fail "the signing key is not $key_name (installer pin $key_hash)"

node "$release_tooling/ops/release/verify-release-assets.mjs" "$dist" --tag "$tag" --unsigned

tlog=(--use-signing-config=false --tlog-upload=false)
[[ "${JANKURAI_RELEASE_TLOG_UPLOAD:-0}" != 1 ]] || { note 'owner opted in: uploading signatures to the public Rekor log'; tlog=(); }
for asset in "$dist"/*; do
  case "$asset" in *.sha256|*.cosign.bundle|*.pub) continue ;; esac
  "$cosign" sign-blob --yes --key "$key" "${tlog[@]}" --bundle "$asset.cosign.bundle" "$asset" >/dev/null 2>&1 ||
    fail "signing failed: $(basename "$asset")"
done
install -m 0644 "$public_key" "$dist/$key_name"
bash "$release_tooling/ops/release/verify-release.sh" --dist "$dist" --tag "$tag"
printf 'Signed %s with %s (sha256 %s)\n' "$tag" "$key_name" "$key_hash"
