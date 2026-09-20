# Jankurai

<!-- jankurai-badge:start -->
[![Jankurai score: 91/100](agent/jankurai-badge.svg)](agent/jankurai-badge.json)
<!-- jankurai-badge:end -->

Score for protected revision [fb97e59](https://github.com/neverhuman/jankurai/commit/fb97e59686fb4c6e1f27b4d567adf8d7606bc881):
[ratchet report](agent/badge-source/repo-score.json) · [CI provenance](agent/badge-source/provenance.json).

[**Current release v1.7.0**](https://github.com/neverhuman/jankurai/releases/tag/v1.7.0)
· [CI](https://github.com/neverhuman/jankurai/actions/workflows/ci.yml)
· [Install](docs/install.md)
· [AGENTS.md](AGENTS.md)

Jankurai audits a repository for unsafe changes, missing proof, unclear ownership,
and drift between code and its contracts. It writes a reviewable report and a
repair queue. It does not execute repository commands.

![Jankurai audit](docs/demo/audit-readme.gif)

## Install

Linux x86-64 and Apple Silicon macOS:

```sh
bash -o pipefail -c 'curl --proto "=https" --tlsv1.2 -fsSL https://raw.githubusercontent.com/neverhuman/jankurai/v1.7.0/jankurai-installer.sh | bash -s -- --tag v1.7.0'
export PATH="$HOME/.local/bin:$PATH"
jankurai --version
# jankurai 1.7.0
jankurai audit .
```

The installer verifies checksums, Sigstore signatures, GitHub attestations, and
embedded provenance, then runs the staged binary before replacing an existing
install. Native Windows, Intel macOS, Linux ARM64, and Alpine/musl are not
supported.

Repo bootstrap (`init`, pre-commit on the diff, `upgrade`) ships in the next
CLI release. Until then, install with the command above and audit locally or in CI.

## GitHub Action

Pin the Action by commit. The immutable hub `@v1.7.0` Action tag does not accept
`fail-under`. Leave `plan` empty.

```yaml
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
  with:
    persist-credentials: false
- uses: neverhuman/jankurai-action@4a45526ac904315f96e6bbebda4e088268023afa
  id: quality
  with:
    release-tag: v1.7.0
    fail-under: '85'
- uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
  if: always()
  with:
    name: jankurai-report
    path: ${{ steps.quality.outputs.report-directory }}
```

## Contributor clone

```sh
git clone https://github.com/neverhuman/jankurai.git
cd jankurai
bash scripts/family.sh setup
```

This hub assembles 14 component repositories via `family.lock`. Setup clones
missing siblings, verifies immutable `ci-<sha>` tags, and fuses a local build.
No Git worktrees. Candidate lock updates run in a disposable sandbox clone.

Family scores live in [docs/components.md](docs/components.md).
More install detail: [docs/install.md](docs/install.md).
Security: [SECURITY.md](SECURITY.md).
