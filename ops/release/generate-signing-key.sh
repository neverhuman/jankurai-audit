#!/usr/bin/env bash
# Owner-run, once per key: create the release signing key pair on the signing host.
#
#   ops/release/generate-signing-key.sh [--dir ~/.config/jankurai-release] [--name jankurai-release-2026]
#
# cosign prompts for the key password (it is never passed on the command line).
# The private key stays in --dir (mode 0700, file 0600), which must be outside
# every Git repository. The script prints the public key and its SHA-256; commit
# them with ops/release/install-public-key.sh in a follow-up PR.
# shellcheck source=ops/release/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dir="${HOME}/.config/jankurai-release" name=jankurai-release-2026
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) dir="${2:?}"; shift 2 ;;
    --name) name="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done
[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail "invalid key name: $name"
cosign="$(pinned_cosign)"
umask 077
mkdir -p "$dir"
[[ ! -L "$dir" ]] || fail "key directory must not be a symlink: $dir"
chmod 700 "$dir"
dir="$(cd "$dir" && pwd)"
if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  fail "key directory is inside a Git repository: $dir"
fi
for file in "$dir/$name.key" "$dir/$name.pub"; do
  [[ ! -e "$file" ]] || fail "refusing to overwrite an existing key file: $file"
done
[[ -t 0 || -n "${COSIGN_PASSWORD+set}" ]] || fail 'run from a terminal so cosign can prompt for the key password'
(cd "$dir" && "$cosign" generate-key-pair --output-key-prefix "$name")
chmod 600 "$dir/$name.key"
chmod 644 "$dir/$name.pub"
require_private_file "$dir/$name.key" 'release signing key'
cat <<EOF

Private key: $dir/$name.key  (mode 600; back it up offline, never copy it into a repository)
Public key:  $dir/$name.pub
SHA-256:     $(sha256 "$dir/$name.pub")

$(cat "$dir/$name.pub")

Next, in a hub checkout on a new branch:
  ops/release/install-public-key.sh $dir/$name.pub
then commit release-keys/$name.pub and jankurai-installer.sh and open a PR.
EOF
