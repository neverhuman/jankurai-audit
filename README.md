# Jankurai

<!-- jankurai-badge:start -->
[![Jankurai score: 91/100](agent/jankurai-badge.svg)](agent/jankurai-badge.json)
<!-- jankurai-badge:end -->

Score for protected revision [fb97e59](https://github.com/neverhuman/jankurai/commit/fb97e59686fb4c6e1f27b4d567adf8d7606bc881):
[ratchet report](agent/badge-source/repo-score.json) · [CI provenance](agent/badge-source/provenance.json).

That 91/100 is the stored full ratchet of `fb97e59`. It covers this hub at that
revision. Each other family repository publishes its own badge. The hub scan
skips `.fusion/`, so member product code is scored in that member repository,
and the integration job is what builds the fused auditor. The check is static
policy and structure. Application pentests, cloud IAM, Terraform or Kubernetes
posture, and runtime authorization are outside it.

[**Current release v1.7.1**](https://github.com/neverhuman/jankurai/releases/tag/v1.7.1)
· [CI](https://github.com/neverhuman/jankurai/actions/workflows/ci.yml)
· [Install](docs/install.md)
· [AGENTS.md](AGENTS.md)

Jankurai audits a repository for unsafe changes, missing proof, unclear ownership,
and drift between code and its contracts. It writes a reviewable report and a
repair queue. It does not execute repository commands.

![Jankurai audit](docs/demo/audit-readme.gif)

Open the [1920×1080 full-resolution GIF](docs/demo/audit-1080p.gif).

## Where the code lives

| Piece | Repository | Use it for |
| --- | --- | --- |
| Hub | [jankurai](https://github.com/neverhuman/jankurai) | Installer, release assets, `family.lock`, `scripts/family.sh` |
| Auditor | [jankurai-core](https://github.com/neverhuman/jankurai-core) | `jankurai` CLI, rules, `diff-audit`, `rules export` |
| Action | [jankurai-action](https://github.com/neverhuman/jankurai-action) | Composite Action to pin from consumer workflows |
| Tools | `jankurai-tools-*` | Libraries the fused build compiles. Not install targets |
| Standard, contracts, conformance, paper, deploy | their own repositories | Doctrine, schemas, fixtures, paper, deploy notes |

Detail: [docs/architecture.md](docs/architecture.md).
The locked auditor's rule catalog is
[docs/rule-catalog.md at 0e2c573](https://github.com/neverhuman/jankurai-core/blob/0e2c573ad2f2fe427a2a1227fac86c1435852a45/docs/rule-catalog.md).

## Install

Linux x86-64 and Apple Silicon macOS:

```sh
bash -o pipefail -c 'curl --proto "=https" --tlsv1.2 -fsSL https://raw.githubusercontent.com/neverhuman/jankurai/v1.7.1/jankurai-installer.sh | bash -s -- --tag v1.7.1'
export PATH="$HOME/.local/bin:$PATH"
jankurai --version
# jankurai 1.7.1
jankurai audit .
```

The installer verifies checksums, Sigstore signatures, GitHub attestations, and
embedded provenance, then runs the staged binary before replacing an existing
install. Native Windows, Intel macOS, Linux ARM64, and Alpine/musl are not
supported.

`v1.7.1` includes `jankurai init`, a pre-commit that runs `diff-audit`, and
`jankurai upgrade`. Install with the command above and audit locally or in CI.

## GitHub Action

Pin the Action by commit. The immutable hub `@v1.7.0` Action tag does not accept
`fail-under`. On the pin below, omitting `fail-under` uses the Action default
of 85. Leave `plan` empty.

```yaml
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
  with:
    persist-credentials: false
- uses: neverhuman/jankurai-action@4a45526ac904315f96e6bbebda4e088268023afa
  id: quality
  with:
    release-tag: v1.7.1
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

When the siblings are already checked out, `bash scripts/family.sh status`
reports lock drift in under a second. `bash scripts/ci-doctor.sh` is the first
check when a local lane does not match CI. The GitHub integration job, which
includes family setup, build, tests, and the demo GIF check, is capped at 90
minutes. The 2026-09-20 integration run for the consumer-install pull request
finished in about 37 minutes.

Family scores live in [docs/components.md](docs/components.md).
More install detail: [docs/install.md](docs/install.md).
Security: [SECURITY.md](SECURITY.md).
