#!/usr/bin/env bash
# Owner-run: publish a signed, verified release inventory to the GitHub mirror.
#   ops/release/publish-github-release.sh --tag vX.Y.Z --dist target/release-dist/vX.Y.Z --dry-run
#   ops/release/publish-github-release.sh --tag vX.Y.Z --dist target/release-dist/vX.Y.Z \
#     --token-file ~/.config/jankurai-release/github-token
# The tag must already exist on GitHub at the built commit. The token (a
# fine-grained token with contents:write on the hub mirror only) is read from a
# 0600 file and never echoed. --dry-run makes no writes; with --token-file it uses
# the token for its reads only.
set -euo pipefail
exec node "$(dirname "${BASH_SOURCE[0]}")/publish-github-release.mjs" "$@"
