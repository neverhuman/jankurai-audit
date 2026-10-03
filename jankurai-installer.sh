#!/usr/bin/env bash
# Install verified public tarballs. Releases from v1.7.2 on are built on our own
# build hosts and signed with a release key whose SHA-256 is pinned below;
# v1.7.1 and earlier keep their GitHub workflow (Sigstore keyless) identity.
set -euo pipefail
fail() { printf 'installer: %s\n' "$*" >&2; exit 1; }
repo="${JANKURAI_RELEASE_REPO:-neverhuman/jankurai-audit}"
tag="${JANKURAI_RELEASE_TAG:-v1.7.2}"
install_dir="${JANKURAI_INSTALL_DIR:-$HOME/.local/bin}"
product=jankurai
verify_only=false
print_asset=false
assets_dir=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) repo="${2:?missing repository}"; shift 2 ;;
    --tag) tag="${2:?missing tag}"; shift 2 ;;
    --product) product="${2:?missing product}"; shift 2 ;;
    --install-dir) install_dir="${2:?missing directory}"; shift 2 ;;
    --assets-dir) assets_dir="${2:?missing asset directory}"; shift 2 ;;
    --verify-only) verify_only=true; shift ;;
    --print-asset-name) print_asset=true; shift ;;
    --help|-h) printf 'usage: jankurai-installer.sh [--tag v1.7.2] [--product jankurai|tuiwright] [--repo owner/repo] [--install-dir path] [--verify-only] [--print-asset-name] [--assets-dir path]\n'; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'invalid repository'
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || fail 'invalid version tag'
[[ "$product" == jankurai || "$product" == tuiwright ]] || fail 'unsupported product'
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) target=x86_64-unknown-linux-gnu ;;
  Darwin/arm64) target=aarch64-apple-darwin ;;
  *) fail 'supported platforms: Linux x86-64 and Apple Silicon macOS' ;;
esac
# Keyless releases (v1.7.1 and earlier): the hub was renamed from
# neverhuman/jankurai to neverhuman/jankurai-audit after v1.7.1, and Sigstore
# certificates keep the repository name they were signed under, so those tags
# verify only as neverhuman/jankurai. Other repositories verify as themselves.
signer="$repo"
if [[ "$repo" == neverhuman/jankurai || "$repo" == neverhuman/jankurai-audit ]]; then
  IFS=. read -r major minor patch <<< "${tag#v}"
  patch="${patch%%[!0-9]*}"
  major=$((10#$major)) minor=$((10#$minor)) patch=$((10#$patch))
  if (( major < 1 || (major == 1 && (minor < 7 || (minor == 7 && patch <= 1))) )); then
    signer=neverhuman/jankurai
  else
    signer=neverhuman/jankurai-audit
  fi
fi
# Releases from v1.7.2 on are signed with a key we hold, not a workflow identity.
# Each line is name|sha256|first tag|last tag (empty: still current). Exactly one
# key covers a tag. Rotation closes the old key's range and appends the next key;
# the downloaded key file must match its pinned SHA-256. An all-zero pin means the
# key is not provisioned yet, and every tag it covers is refused.
release_keys='
jankurai-release-2026.pub|0000000000000000000000000000000000000000000000000000000000000000|v1.7.2|
'
version_number() {
  local major minor patch
  IFS=. read -r major minor patch <<< "${1#v}"
  patch="${patch%%[!0-9]*}"
  printf '%d' $(( 10#$major * 1000000 + 10#$minor * 1000 + 10#$patch ))
}
signing=keyless
if (( $(version_number "$tag") > $(version_number v1.7.1) )); then signing=key; fi
stem="$product-${tag#v}-$target"
asset="$stem.tar.gz"
if "$print_asset"; then printf '%s\n' "$asset"; exit 0; fi
if [[ "$signing" == key ]]; then
  key_name='' key_hash=''
  while IFS='|' read -r name hash first last; do
    [[ -n "$name" ]] || continue
    (( $(version_number "$tag") >= $(version_number "$first") )) || continue
    [[ -z "$last" ]] || (( $(version_number "$tag") <= $(version_number "$last") )) || continue
    [[ -z "$key_name" ]] || fail "more than one release signing key covers $tag"
    key_name="$name" key_hash="$hash"
  done <<< "$release_keys"
  [[ -n "$key_name" ]] || fail "no release signing key covers $tag"
  [[ "$key_hash" =~ ^[0-9a-f]{64}$ && ! "$key_hash" =~ ^0+$ ]] ||
    fail "the release signing key for $tag is not provisioned in this installer"
fi
for tool in curl tar cmp; do command -v "$tool" >/dev/null || fail "missing system tool: $tool"; done
sha256() {
  if command -v shasum >/dev/null; then shasum -a 256 "$1" | cut -d ' ' -f 1
  else sha256sum "$1" | cut -d ' ' -f 1
  fi
}
work="$(mktemp -d)"
staged_binary=
cleanup() {
  [[ -z "$staged_binary" ]] || rm -f "$staged_binary"
  rm -rf "$work"
}
trap cleanup EXIT
mkdir -p "$work/bin" "$work/gh-config"
# Upstream release SHA-256 hashes are pinned here, never fetched as trust inputs.
case "$target" in
  x86_64-unknown-linux-gnu)
    gh_archive=gh_2.100.0_linux_amd64.tar.gz
    gh_hash=e4d4bb4498e8d007abe545b6568926793ace1b6447da598294a610018cb164be
    cosign_asset=cosign-linux-amd64
    cosign_hash=4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71
    jq_asset=jq-linux-amd64
    jq_hash=b1c22172dd303f3be49e935aa56aa48a8b7a46e0bc838b4997d3bb451495870f
    ;;
  aarch64-apple-darwin)
    gh_archive=gh_2.100.0_macOS_arm64.zip
    gh_hash=45f9a62da2f6e641a7fad57e2ce39656dfd7ef331372d80a2a2aed65abb01642
    cosign_asset=cosign-darwin-arm64
    cosign_hash=5cf948c2f4dfe59687bdd0b8523709067383e03982cc543475c8a7dc70e92a76
    jq_asset=jq-macos-arm64
    jq_hash=2d75340ba57a4b4b4c8708a21c2dc8e958a48aaa8bba13b27f77f6e4c0eca07e
    command -v unzip >/dev/null || fail 'missing system tool: unzip'
    ;;
esac
fetch_tool() {
  local url="$1" output="$2" expected="$3"
  curl --proto '=https' --tlsv1.2 -fsSL "$url" -o "$output"
  [[ "$(sha256 "$output")" == "$expected" ]] || fail 'verification tool checksum mismatch'
}
# GitHub CLI verifies attestations, which only the keyless releases have.
if [[ "$signing" == keyless ]]; then
  fetch_tool "https://github.com/cli/cli/releases/download/v2.100.0/$gh_archive" "$work/$gh_archive" "$gh_hash"
  if [[ "$target" == x86_64-unknown-linux-gnu ]]; then
    tar -xOzf "$work/$gh_archive" gh_2.100.0_linux_amd64/bin/gh > "$work/bin/gh"
  else
    unzip -p "$work/$gh_archive" gh_2.100.0_macOS_arm64/bin/gh > "$work/bin/gh"
  fi
  chmod 0755 "$work/bin/gh"
fi
fetch_tool "https://github.com/sigstore/cosign/releases/download/v3.1.3/$cosign_asset" "$work/bin/cosign" "$cosign_hash"
fetch_tool "https://github.com/jqlang/jq/releases/download/jq-1.8.2/$jq_asset" "$work/bin/jq" "$jq_hash"
chmod 0755 "$work/bin/cosign" "$work/bin/jq"
base="https://github.com/$repo/releases/download/$tag"
if [[ "$signing" == key ]]; then
  downloads=("$asset" "$asset.sha256" "$asset.cosign.bundle" "$key_name")
else
  downloads=("$asset" "$asset.sha256" "$asset.sigstore.bundle" "$asset.attestation.jsonl")
fi
for name in "${downloads[@]}"; do
  if [[ -n "$assets_dir" ]]; then
    cp "$assets_dir/$name" "$work/$name"
  else
    curl --proto '=https' --tlsv1.2 -fsSL "$base/$name" -o "$work/$name"
  fi
done
identity="https://github.com/$signer/.github/workflows/release.yml@refs/tags/$tag"
[[ "$(cat "$work/$asset.sha256")" == "$(sha256 "$work/$asset")  $asset" ]] || fail 'checksum mismatch'
if [[ "$signing" == key ]]; then
  [[ "$(sha256 "$work/$key_name")" == "$key_hash" ]] || fail 'release signing key does not match its pin'
  # Key-signed bundles carry no transparency-log entry by design (see SECURITY.md).
  "$work/bin/cosign" verify-blob "$work/$asset" --bundle "$work/$asset.cosign.bundle" \
    --key "$work/$key_name" --insecure-ignore-tlog=true --offline=true 2> "$work/cosign.log" ||
    { cat "$work/cosign.log" >&2; fail 'release signature verification failed'; }
else
  "$work/bin/cosign" verify-blob "$work/$asset" --bundle "$work/$asset.sigstore.bundle" \
    --certificate-identity "$identity" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
fi
tar -tzf "$work/$asset" | sed 's:/$::' | LC_ALL=C sort > "$work/inventory"
printf '%s\n' "$stem" "$stem/$product" "$stem/family.lock" "$stem/Cargo.lock" \
  "$stem/LICENSE" "$stem/provenance.json" | LC_ALL=C sort > "$work/expected"
cmp -s "$work/inventory" "$work/expected" || fail 'unexpected archive inventory'
tar -tvzf "$work/$asset" > "$work/details"
if LC_ALL=C grep -qv '^[-d]' "$work/details"; then fail 'unsafe archive entry'; fi
mkdir "$work/payload"
tar -xzf "$work/$asset" --no-same-owner -C "$work/payload"
payload="$work/payload/$stem"
# jq expands these --arg bindings; Bash must leave them literal.
if [[ "$signing" == key ]]; then
  # shellcheck disable=SC2016
  "$work/bin/jq" -e --arg target "$target" --arg version "${tag#v}" --arg tag "$tag" \
    '.schema == "jankurai.release/v2" and .repository == "https://github.com/neverhuman/jankurai-audit" and (.commit | test("^[0-9a-f]{40}$")) and (.tree | test("^[0-9a-f]{40}$")) and .tag == $tag and .target == $target and .version == $version' \
    "$payload/provenance.json" >/dev/null || fail 'release provenance mismatch'
else
  # shellcheck disable=SC2016
  "$work/bin/jq" -e --arg repo "https://github.com/$signer" --arg target "$target" --arg version "${tag#v}" \
    '.schema == "jankurai.release/v1" and .repository == $repo and (.commit | test("^[0-9a-f]{40}$")) and .target == $target and .version == $version' \
    "$payload/provenance.json" >/dev/null || fail 'release provenance mismatch'
fi
# shellcheck disable=SC2016
"$work/bin/jq" -e --arg family "$(sha256 "$payload/family.lock")" --arg cargo "$(sha256 "$payload/Cargo.lock")" \
  '.family_lock_sha256 == $family and .cargo_lock_sha256 == $cargo' \
  "$payload/provenance.json" >/dev/null || fail 'lock provenance mismatch'

if [[ "$signing" == keyless ]]; then
  release_commit="$("$work/bin/jq" -er '.commit' "$payload/provenance.json")"
  # Local bundles avoid GitHub API authentication. Enforce certificate identities,
  # including the source commit and tag, rather than trusting predicate text alone.
  env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN \
    GH_CONFIG_DIR="$work/gh-config" "$work/bin/gh" attestation verify "$work/$asset" \
    --bundle "$work/$asset.attestation.jsonl" --repo "$signer" \
    --cert-identity "$identity" --cert-oidc-issuer https://token.actions.githubusercontent.com \
    --signer-digest "$release_commit" --source-digest "$release_commit" \
    --source-ref "refs/tags/$tag" --deny-self-hosted-runners
fi
chmod 0755 "$payload/$product"
actual_version="$("$payload/$product" --version)" || fail 'staged binary failed to run'
[[ "$actual_version" == "$product ${tag#v}" ]] || fail "binary version mismatch: $actual_version"
if "$verify_only"; then printf 'Verified and ran %s\n' "$asset"; exit 0; fi
mkdir -p "$install_dir"
staged_binary="$(mktemp "$install_dir/.$product.XXXXXX")"
install -m 0755 "$payload/$product" "$staged_binary"
[[ "$("$staged_binary" --version)" == "$product ${tag#v}" ]] || fail 'installed staging check failed'
mv -f "$staged_binary" "$install_dir/$product"
staged_binary=
printf 'Installed %s/%s (%s)\n' "$install_dir" "$product" "$tag"
