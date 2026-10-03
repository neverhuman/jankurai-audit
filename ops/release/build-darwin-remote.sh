#!/usr/bin/env bash
# Optional: build the aarch64-apple-darwin target on a macOS build host over SSH
# and bring its unsigned assets back into the local inventory. Signing stays on
# the signing host; the private key never goes to the macOS host.
#
#   ops/release/build-darwin-remote.sh --host <ssh-alias> --tag vX.Y.Z \
#     [--dist target/release-dist/vX.Y.Z] [--remote-dir jankurai-release] [--members hosted|mirror]
#
# The macOS host needs git, rustup (the tag's rust-toolchain.toml channel is
# installed on demand), Node.js with npm, the system tar, and read access to the
# member sources (the forge with its own credentials, or --members mirror).
# shellcheck source=ops/release/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

host='' tag='' dist='' remote_dir=jankurai-release members=hosted
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) host="${2:?}"; shift 2 ;;
    --tag) tag="${2:?}"; shift 2 ;;
    --dist) dist="${2:?}"; shift 2 ;;
    --remote-dir) remote_dir="${2:?}"; shift 2 ;;
    --members) members="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done
[[ -n "$host" ]] || fail '--host is required'
valid_release_tag "$tag" || fail 'a release tag vX.Y.Z is required'
[[ "$remote_dir" =~ ^[A-Za-z0-9._/-]+$ && "$remote_dir" != /* && "$remote_dir" != *..* ]] ||
  fail '--remote-dir must be a plain path relative to the remote home'
[[ "$members" == hosted || "$members" == mirror ]] || fail '--members must be hosted or mirror'
dist="${dist:-$release_tooling/target/release-dist/$tag}"
[[ -f "$dist/provenance-x86_64-unknown-linux-gnu.json" ]] || fail "build the Linux target into $dist first"
[[ -z "$(git -C "$release_tooling" status --porcelain)" ]] || fail 'release tooling checkout must be clean'
tooling_commit="$(git -C "$release_tooling" rev-parse HEAD)"
git -C "$release_tooling" rev-parse --verify --quiet "refs/tags/$tag^{commit}" >/dev/null || fail "tag $tag is not in this checkout"

[[ "$(ssh "$host" 'uname -s; uname -m' | tr '\n' /)" == Darwin/arm64/ ]] || fail "$host is not an Apple Silicon macOS host"
bundle="$(mktemp -d)"
trap 'rm -rf "$bundle"' EXIT
# One bundle carries the tooling commit and the release tag.
git -C "$release_tooling" bundle create "$bundle/release.bundle" HEAD "refs/tags/$tag" 2>/dev/null
remote="$remote_dir/$tag-$tooling_commit"
# shellcheck disable=SC2029 # values are expanded locally on purpose
ssh "$host" "test ! -e '$remote' && mkdir -p '$remote'" || fail "remote build directory exists; remove it first: $remote"
scp -q "$bundle/release.bundle" "$host:$remote/release.bundle"
# shellcheck disable=SC2029
ssh "$host" "set -e; cd '$remote'
  git clone --quiet release.bundle tooling
  git -C tooling fetch --quiet ../release.bundle 'refs/tags/$tag:refs/tags/$tag'
  git -C tooling checkout --quiet --detach '$tooling_commit'
  bash tooling/ops/release/build-release.sh --tag '$tag' --target aarch64-apple-darwin \
    --source-repo \"\$PWD/tooling\" --members '$members' --out \"\$PWD/dist\" --workdir \"\$PWD/build\""
mkdir -p "$bundle/darwin"
scp -q "$host:$remote/dist/*aarch64-apple-darwin*" "$bundle/darwin/"
for file in "$bundle/darwin"/*; do
  name="$(basename "$file")"
  [[ "$name" == *aarch64-apple-darwin* ]] || fail "unexpected file from the macOS host: $name"
  [[ ! -e "$dist/$name" ]] || fail "inventory already holds $name"
done
cp "$bundle/darwin"/* "$dist/"
node "$release_tooling/ops/release/verify-release-assets.mjs" "$dist" --tag "$tag" --unsigned
printf 'Added aarch64-apple-darwin assets from %s to %s; sign the combined inventory next\n' "$host" "$dist"
