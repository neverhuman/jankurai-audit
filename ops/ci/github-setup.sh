#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
if [[ "$(uname -s)" == Linux ]]; then
  sudo apt-get update
  sudo apt-get install -y pkg-config libssl-dev libfuse3-dev latexmk texlive-latex-extra texlive-fonts-recommended texlive-publishers
fi
if [[ "${CI_INSTALL_SECURITY:-1}" == 1 && "$(uname -s)" == Linux ]]; then
  bash ops/ci/install-security-tools.sh
fi
# GitHub-hosted runners cannot read the private forge: take members and their
# pin tags from the public mirrors, and route the members' pre-rename Cargo git
# sources to those mirrors. Locked commits are verified either way.
export JANKURAI_FAMILY_SOURCE=mirror
if [[ -n "${GITHUB_ENV:-}" ]]; then printf 'JANKURAI_FAMILY_SOURCE=mirror\n' >> "$GITHUB_ENV"; fi
while read -r legacy mirror; do
  git config --global --add "url.$mirror.insteadOf" "$legacy"
done < <(bash scripts/family.sh mirror-routes)
bash scripts/family.sh setup
if [[ "$(uname -s)" == Linux ]]; then
  (cd ../jankurai-tools-ux && npm exec -- playwright install --with-deps chromium --only-shell)
  # Proof's required lane checks a governed public-API digest.
  rustup toolchain install nightly-2026-06-16 --profile minimal
  rustup component add rust-docs --toolchain nightly-2026-06-16 || true
  cargo install cargo-public-api --version 0.52.0 --locked
fi
