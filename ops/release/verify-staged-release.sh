#!/usr/bin/env bash
# Verify a signed staged release before publication, then install it through
# the installer's own verification path and run the native products.
#   ops/release/verify-staged-release.sh --dist target/release-dist/vX.Y.Z --tag vX.Y.Z
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
dist="$(cd "${dist:?--dist is required}" && pwd)"
bash "$release_tooling/ops/release/verify-release.sh" --dist "$dist" --tag "$tag"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
# The inventory's installer is the one users will download; exercise that copy.
for product in jankurai tuiwright; do
  env -u GH_TOKEN -u GITHUB_TOKEN bash "$dist/jankurai-installer.sh" \
    --tag "$tag" --product "$product" --assets-dir "$dist" --install-dir "$stage/bin"
done
"$stage/bin/jankurai" audit "$release_tooling" --mode advisory --full --no-score-history \
  --json "$stage/audit.json" --md "$stage/audit.md"
if command -v npm >/dev/null && [[ -f "$dist/jankurai-ux-qa-${tag#v}.tgz" ]]; then
  npm install --silent --prefix "$stage/ux" "$dist/jankurai-ux-qa-${tag#v}.tgz" playwright@1.59.1
  [[ "$("$stage/ux/node_modules/.bin/jankurai-ux-qa" --version)" == "jankurai-ux-qa ${tag#v}" ]]
fi
printf 'Staged %s verified, installed and run on %s\n' "$tag" "$(host_target)"
