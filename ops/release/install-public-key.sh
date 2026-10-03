#!/usr/bin/env bash
# Commit a release public key into this checkout: copy it to release-keys/<name>
# and pin its SHA-256 in jankurai-installer.sh's release_keys table.
#
#   ops/release/install-public-key.sh <public key file> [--name jankurai-release-2026.pub]
#
# The named entry must already exist in the table (the placeholder, or a rotation
# entry you added with its tag range). Private keys are refused.
# shellcheck source=ops/release/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

public='' name=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) name="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    -*) fail "unknown argument: $1" ;;
    *) public="$1"; shift ;;
  esac
done
[[ -f "$public" && ! -L "$public" ]] || fail 'a public key file is required'
name="${name:-$(basename "$public")}"
[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.pub$ ]] || fail "invalid key file name: $name"
! grep -q 'PRIVATE' "$public" || fail 'that is a private key; pass the .pub file'
[[ "$(head -n 1 "$public")" == '-----BEGIN PUBLIC KEY-----' && "$(tail -n 1 "$public")" == '-----END PUBLIC KEY-----' ]] ||
  fail 'expected a PEM public key from cosign generate-key-pair'
if command -v openssl >/dev/null; then
  openssl pkey -pubin -in "$public" -noout 2>/dev/null || fail 'the public key does not parse'
fi
installer="$release_tooling/jankurai-installer.sh"
grep -q "^$name|[0-9a-f]\{64\}|" "$installer" || fail "jankurai-installer.sh has no release_keys entry for $name"
hash="$(sha256 "$public")"
install -m 0644 "$public" "$release_tooling/release-keys/$name"
updated="$(sed "s/^$name|[0-9a-f]\{64\}|/$name|$hash|/" "$installer")"
printf '%s\n' "$updated" > "$installer"
grep -q "^$name|$hash|" "$installer" || fail 'pin update failed'
printf 'Pinned release-keys/%s (sha256 %s) in jankurai-installer.sh\n' "$name" "$hash"
