#!/usr/bin/env bash
# Install pinned upstream Linux tools after verifying their published checksums.
set -euo pipefail
[[ "$(uname -s)/$(uname -m)" == Linux/x86_64 ]]
install_root="${CARGO_HOME:-$HOME/.cargo}/bin"
mkdir -p "$install_root"
archive_root="$(mktemp -d)"
trap 'rm -rf "$archive_root"' EXIT
install_release() {
  local repository="$1" version="$2" binary="$3" architecture="$4"
  local archive="${binary}_${version}_linux_${architecture}.tar.gz"
  local checksums="${binary}_${version}_checksums.txt"
  local base="https://github.com/$repository/releases/download/v$version"
  curl --proto '=https' --tlsv1.2 --retry 8 --retry-all-errors --retry-delay 3 -fsSL "$base/$archive" -o "$archive_root/$archive"
  curl --proto '=https' --tlsv1.2 --retry 8 --retry-all-errors --retry-delay 3 -fsSL "$base/$checksums" -o "$archive_root/$checksums"
  (cd "$archive_root" && awk -v name="$archive" '$2 == name { print; count++ } END { if (count != 1) exit 1 }' "$checksums" > selected.sha256 && sha256sum -c selected.sha256)
  tar -xzf "$archive_root/$archive" -C "$archive_root" "$binary"
  install -m 0755 "$archive_root/$binary" "$install_root/$binary"
  "$install_root/$binary" --version
}
install_release gitleaks/gitleaks 8.21.2 gitleaks x64
install_release anchore/grype 0.99.0 grype amd64
