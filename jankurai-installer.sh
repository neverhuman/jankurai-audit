#!/usr/bin/env bash
# Install verified public tarballs from the immutable release workflow identity.
set -euo pipefail
fail() { printf 'installer: %s\n' "$*" >&2; exit 1; }
repo="${JANKURAI_RELEASE_REPO:-neverhuman/jankurai}"
tag="${JANKURAI_RELEASE_TAG:-v1.7.1}"
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
    --help|-h) printf 'usage: jankurai-installer.sh [--tag v1.7.1] [--product jankurai|tuiwright] [--repo owner/repo] [--install-dir path] [--verify-only] [--print-asset-name] [--assets-dir path]\n'; exit 0 ;;
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
stem="$product-${tag#v}-$target"
asset="$stem.tar.gz"
if "$print_asset"; then printf '%s\n' "$asset"; exit 0; fi
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
fetch_tool "https://github.com/cli/cli/releases/download/v2.100.0/$gh_archive" "$work/$gh_archive" "$gh_hash"
if [[ "$target" == x86_64-unknown-linux-gnu ]]; then
  tar -xOzf "$work/$gh_archive" gh_2.100.0_linux_amd64/bin/gh > "$work/bin/gh"
else
  unzip -p "$work/$gh_archive" gh_2.100.0_macOS_arm64/bin/gh > "$work/bin/gh"
fi
fetch_tool "https://github.com/sigstore/cosign/releases/download/v3.1.3/$cosign_asset" "$work/bin/cosign" "$cosign_hash"
fetch_tool "https://github.com/jqlang/jq/releases/download/jq-1.8.2/$jq_asset" "$work/bin/jq" "$jq_hash"
chmod 0755 "$work/bin/gh" "$work/bin/cosign" "$work/bin/jq"
base="https://github.com/$repo/releases/download/$tag"
for name in "$asset" "$asset.sha256" "$asset.sigstore.bundle" "$asset.attestation.jsonl"; do
  if [[ -n "$assets_dir" ]]; then
    cp "$assets_dir/$name" "$work/$name"
  else
    curl --proto '=https' --tlsv1.2 -fsSL "$base/$name" -o "$work/$name"
  fi
done
identity="https://github.com/$repo/.github/workflows/release.yml@refs/tags/$tag"
[[ "$(cat "$work/$asset.sha256")" == "$(sha256 "$work/$asset")  $asset" ]] || fail 'checksum mismatch'
"$work/bin/cosign" verify-blob "$work/$asset" --bundle "$work/$asset.sigstore.bundle" \
  --certificate-identity "$identity" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
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
# shellcheck disable=SC2016
"$work/bin/jq" -e --arg repo "https://github.com/$repo" --arg target "$target" --arg version "${tag#v}" \
  '.schema == "jankurai.release/v1" and .repository == $repo and (.commit | test("^[0-9a-f]{40}$")) and .target == $target and .version == $version' \
  "$payload/provenance.json" >/dev/null || fail 'release provenance mismatch'
# shellcheck disable=SC2016
"$work/bin/jq" -e --arg family "$(sha256 "$payload/family.lock")" --arg cargo "$(sha256 "$payload/Cargo.lock")" \
  '.family_lock_sha256 == $family and .cargo_lock_sha256 == $cargo' \
  "$payload/provenance.json" >/dev/null || fail 'lock provenance mismatch'

release_commit="$("$work/bin/jq" -er '.commit' "$payload/provenance.json")"
# Local bundles avoid GitHub API authentication. Enforce certificate identities,
# including the source commit and tag, rather than trusting predicate text alone.
env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN \
  GH_CONFIG_DIR="$work/gh-config" "$work/bin/gh" attestation verify "$work/$asset" \
  --bundle "$work/$asset.attestation.jsonl" --repo "$repo" \
  --cert-identity "$identity" --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --signer-digest "$release_commit" --source-digest "$release_commit" \
  --source-ref "refs/tags/$tag" --deny-self-hosted-runners
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
