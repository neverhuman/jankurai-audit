#!/usr/bin/env bash
# Exercise the README command with only documented system utilities available.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
: "${RELEASE_TAG:?release tag required}"
[[ "$RELEASE_TAG" == "v$(cat VERSION)" ]]
smoke="$(mktemp -d)"
trap 'rm -rf "$smoke"' EXIT
mkdir -p "$smoke/system-bin" "$smoke/home" "$smoke/tmp" "$smoke/repository"
for tool in bash curl tar gzip cmp shasum sha256sum cut cat chmod cp sed sort grep mkdir mktemp rm env install mv uname unzip; do
  executable="$(command -v "$tool" || true)"
  if [[ -n "$executable" ]]; then ln -s "$executable" "$smoke/system-bin/$tool"; fi
done
anonymous() {
  env -i HOME="$smoke/home" PATH="$smoke/system-bin" TMPDIR="$smoke/tmp" LC_ALL=C "$@"
}
anonymous bash -e <<'CHECK_TOOLS'
for tool in gh cosign jq node cargo rustc; do
  if command -v "$tool"; then exit 1; fi
done
CHECK_TOOLS
install_command="$(sed -n '/^bash -o pipefail -c /{p;q;}' README.md)"
[[ "$install_command" == *"/$RELEASE_TAG/jankurai-installer.sh"* ]] || { echo 'README lacks the pinned install command' >&2; exit 1; }
anonymous bash -c "$install_command"
binary="$smoke/home/.local/bin/jankurai"
[[ "$(anonymous "$binary" --version)" == "jankurai ${RELEASE_TAG#v}" ]]
printf '# Public installation smoke\n' > "$smoke/repository/README.md"
anonymous "$binary" audit "$smoke/repository" --mode advisory \
  --json "$smoke/audit.json" --md "$smoke/audit.md" --repair-queue-jsonl "$smoke/repair-queue.jsonl"
test -s "$smoke/audit.json"
test -s "$smoke/audit.md"
test -f "$smoke/repair-queue.jsonl"
# Reinstallation must leave the same verified binary and no staging files.
cp "$binary" "$smoke/first-install"
anonymous bash -c "$install_command"
cmp "$binary" "$smoke/first-install"
# Verify the installer is also available as a release asset (issue #16).
anonymous curl --proto '=https' --tlsv1.2 -fsSL \
  "https://github.com/neverhuman/jankurai-audit/releases/download/$RELEASE_TAG/jankurai-installer.sh" \
  -o "$smoke/installer.sh"
cmp jankurai-installer.sh "$smoke/installer.sh"
anonymous bash "$smoke/installer.sh" --tag "$RELEASE_TAG" --product tuiwright
[[ "$(anonymous "$smoke/home/.local/bin/tuiwright" --version)" == "tuiwright ${RELEASE_TAG#v}" ]]
anonymous "$smoke/home/.local/bin/tuiwright" --help >/dev/null
anonymous rm "$binary" "$smoke/home/.local/bin/tuiwright"
[[ -z "$(ls -A "$smoke/home/.local/bin")" ]]
printf 'Anonymous public install, audit, TUI, reinstall and removal passed on %s/%s\n' "$(uname -s)" "$(uname -m)"
