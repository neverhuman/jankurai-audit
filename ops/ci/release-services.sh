#!/usr/bin/env bash
# Qualify real signing services before tagging; this identity cannot install a release.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
: "${GITHUB_REPOSITORY:?repository required}"
: "${GITHUB_REF:?source ref required}"
: "${GITHUB_SHA:?source commit required}"
# The hub was renamed from neverhuman/jankurai after v1.7.1; probes run only here.
[[ "$GITHUB_REPOSITORY" == neverhuman/jankurai-audit && "$GITHUB_REF" == refs/heads/* ]]
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]]
workflow="$GITHUB_REPOSITORY/.github/workflows/release-services.yml"
identity="https://github.com/$workflow@$GITHUB_REF"
output=target/release-services
asset="$output/probe.txt"
case "${1:-}" in
  prepare)
    mkdir -p "$output"
    printf 'Non-release signing probe\nsource=%s\nplatform=%s/%s\n' \
      "$GITHUB_SHA" "$(uname -s)" "$(uname -m)" > "$asset"
    cosign sign-blob --yes --bundle "$asset.sigstore.bundle" "$asset"
    ;;
  verify)
    : "${ATTESTATION_BUNDLE:?attestation action bundle required}"
    cp "$ATTESTATION_BUNDLE" "$asset.attestation.jsonl"
    config="$(mktemp -d)"
    trap 'rm -rf "$config"' EXIT
    anonymous() {
      env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN \
        GH_CONFIG_DIR="$config" "$@"
    }
    verify_attestation() {
      anonymous gh attestation verify "$1" --bundle "$asset.attestation.jsonl" \
        --repo "$2" --cert-identity "$3" \
        --cert-oidc-issuer https://token.actions.githubusercontent.com \
        --signer-digest "$GITHUB_SHA" \
        --source-digest "$4" --source-ref "$5" --deny-self-hosted-runners
    }
    verify_signature() {
      anonymous cosign verify-blob "$1" --bundle "$asset.sigstore.bundle" \
        --certificate-identity "$identity" \
        --certificate-oidc-issuer https://token.actions.githubusercontent.com
    }
    reject() {
      if "$@"; then echo 'invalid signing probe unexpectedly verified' >&2; exit 1; fi
    }
    verify_signature "$asset"
    verify_attestation "$asset" "$GITHUB_REPOSITORY" "$identity" "$GITHUB_SHA" "$GITHUB_REF"
    cp "$asset" "$config/tampered.txt"
    printf 'tampered\n' >> "$config/tampered.txt"
    reject verify_signature "$config/tampered.txt"
    reject verify_attestation "$config/tampered.txt" "$GITHUB_REPOSITORY" "$identity" "$GITHUB_SHA" "$GITHUB_REF"
    reject verify_attestation "$asset" neverhuman/jankurai-core "$identity" "$GITHUB_SHA" "$GITHUB_REF"
    reject verify_attestation "$asset" neverhuman/jankurai "$identity" "$GITHUB_SHA" "$GITHUB_REF"
    reject verify_attestation "$asset" "$GITHUB_REPOSITORY" "https://github.com/$GITHUB_REPOSITORY/.github/workflows/release.yml@$GITHUB_REF" "$GITHUB_SHA" "$GITHUB_REF"
    reject verify_attestation "$asset" "$GITHUB_REPOSITORY" "$identity" 0000000000000000000000000000000000000000 "$GITHUB_REF"
    reject verify_attestation "$asset" "$GITHUB_REPOSITORY" "$identity" "$GITHUB_SHA" refs/tags/v1.7.0
    printf 'Real anonymous signatures and attestations verified; modified content and wrong repository/workflow/source/tag rejected.\n' > "$output/result.txt"
    # Bind workflow run / source / artifact / signature identity for local pre-tag qualify.
    printf 'cert-identity=%s\nworkflow=%s\nsource=%s\nartifact=probe.txt\n' \
      "$identity" "$workflow" "$GITHUB_SHA" > "$output/identity.txt"
    cat "$output/result.txt"
    ;;
  *) echo 'usage: release-services.sh prepare|verify' >&2; exit 1 ;;
esac
