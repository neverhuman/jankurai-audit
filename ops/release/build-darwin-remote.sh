#!/usr/bin/env bash
# Build Apple Silicon assets in registered lanes of an existing remote hub.
# The remote host needs the host lane sweeper, Git, rustup, Node/npm and its own
# forge read credentials. Signing credentials never leave the signing host.
# usage: build-darwin-remote.sh --host alias --tag vX.Y.Z --remote-repo /jankurai/repository
#        [--dist target/release-dist/vX.Y.Z] [--members hosted|mirror]
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
host='' tag='' dist='' remote_repo='' members=hosted
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) host="${2:?}"; shift 2 ;;
    --tag) tag="${2:?}"; shift 2 ;;
    --dist) dist="${2:?}"; shift 2 ;;
    --remote-repo) remote_repo="${2:?}"; shift 2 ;;
    --members) members="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done
[[ "$host" =~ ^[A-Za-z0-9][A-Za-z0-9@._-]*$ ]] || fail '--host must be a plain SSH alias'
valid_release_tag "$tag" || fail 'a release tag vX.Y.Z is required'
[[ "$remote_repo" == /jankurai/repository ]] || fail 'native release builds require --remote-repo /jankurai/repository (an existing primary hub)'
[[ "$members" == hosted || "$members" == mirror ]] || fail '--members must be hosted or mirror'
dist="${dist:-$release_tooling/target/release-dist/$tag}"
[[ -f "$dist/provenance-x86_64-unknown-linux-gnu.json" ]] || fail "build the Linux target into $dist first"
[[ -z "$(git -C "$release_tooling" status --porcelain)" ]] || fail 'release tooling checkout must be clean'
tooling_commit="$(git -C "$release_tooling" rev-parse HEAD)"
expected="$(git -C "$release_tooling" rev-parse --verify "refs/tags/$tag^{commit}")"
[[ "$(ssh "$host" 'uname -s; uname -m' | tr '\n' /)" == Darwin/arm64/ ]] || fail "$host is not an Apple Silicon macOS host"
bundle="$release_tooling/target/release-transfer/$tag-$tooling_commit"
[[ ! -e "$bundle" ]] || fail "transfer evidence exists; preserve and inspect it: $bundle"
mkdir -p "$bundle"
git -C "$release_tooling" bundle create "$bundle/release.bundle" HEAD "refs/tags/$tag"
remote="$remote_repo/.agent/release-transfer/$tag-$tooling_commit"
ssh "$host" "test -d '$remote_repo/.git' && test ! -e '$remote' && mkdir -p '$remote'" || fail 'remote primary repository missing or transfer evidence already exists'
scp -q "$bundle/release.bundle" "$host:$remote/release.bundle"
# All interpolated values are constrained above or exact Git object IDs.
ssh "$host" "set -eu
  cd '$remote_repo'
  primary=\"\$(pwd -P)\"
  git fetch --quiet origin main
  git fetch --quiet \"\$primary/.agent/release-transfer/$tag-$tooling_commit/release.bundle\" '$tooling_commit' 'refs/tags/$tag:refs/tags/$tag'
  git merge-base --is-ancestor '$expected' refs/remotes/origin/main
  \"\$HOME/.agent/bin/lanes\" sweep --apply
  count=\$(git worktree list --porcelain | grep -c '^worktree ')
  test \"\$count\" -le 7
  lane=\"\$primary/.agent/worktrees/release-tooling-$tooling_commit\"
  test ! -e \"\$lane\"
  grep -qxF '.agent/' .git/info/exclude || printf '\\n.agent/\\n' >> .git/info/exclude
  git worktree add --detach --lock --reason 'release tooling: $tag' \"\$lane\" '$tooling_commit'
  bash \"\$lane/ops/release/build-release.sh\" --tag '$tag' --expect-commit '$expected' --target aarch64-apple-darwin \\
    --source-repo \"\$primary\" --members '$members' --out \"\$lane/target/release-dist/$tag\""
mkdir -p "$bundle/darwin"
scp -q "$host:$remote_repo/.agent/worktrees/release-tooling-$tooling_commit/target/release-dist/$tag/*aarch64-apple-darwin*" "$bundle/darwin/"
for file in "$bundle/darwin"/*; do
  name="$(basename "$file")"
  [[ "$name" == *aarch64-apple-darwin* && ! -e "$dist/$name" ]] || fail "unexpected or existing asset: $name"
done
cp "$bundle/darwin"/* "$dist/"
node "$release_tooling/ops/release/verify-release-assets.mjs" "$dist" --tag "$tag" --unsigned
printf 'Added Darwin assets; retained both remote lanes and transfer evidence for custody cleanup.\n'
