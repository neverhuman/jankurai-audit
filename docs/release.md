# Release process

The hub publishes releases from version tags. `VERSION`, the auditor version,
the Tuiwright version, and the UX npm package version must agree. The first post-migration release is
`v1.7.0`. The current release is `v1.7.1`. Publish its tag only after every
component default branch, complete hub integration, and both release-platform checks pass.

The release workflow independently checks the locked family, builds Linux x86-64
and Apple Silicon macOS products, runs their version commands, signs every asset
with Sigstore, generates GitHub attestations, verifies the complete inventory,
exports downloadable attestation bundles, installs and runs the staged native
products, and publishes a GitHub Release only after both platforms pass. No self-hosted runner or Apple signing account
is needed for the selected tarball distribution.

Public assets include:

- `jankurai-<version>-<target>.tar.gz`
- `tuiwright-<version>-<target>.tar.gz`
- `jankurai-ux-qa-<version>.tgz`, the built npm CLI package
- `family.lock`, `Cargo.lock`, per-platform provenance, and the installer
- SHA-256 checksums, Sigstore bundles, and GitHub artifact attestations

The governed launcher and `tuiwright-demo` remain internal build/test products.
Tarballs contain only their selected executable, license, locks, and provenance.

## Installation

Download `jankurai-installer.sh` from the desired hub release, then:

```sh
bash jankurai-installer.sh --tag v1.7.1
bash jankurai-installer.sh --tag v1.7.1 --product tuiwright
```

The installer requires the platform shell, curl, archive tools, and SHA-256 tooling.
It downloads temporary GitHub CLI, cosign, and jq binaries at exact versions and
checks their embedded SHA-256 pins. No GitHub login is required. It verifies the checksum, the Sigstore workflow identity and version
tag, the GitHub attestation identity and hosted runner, the release commit, the
archive inventory, and the embedded lock digests before installing. Both platforms
install to `~/.local/bin` by default. `--verify-only` performs all verification
and runs the staged binary without installing. The hub Action metadata defaults to
`v1.7.1`. The immutable `neverhuman/jankurai@v1.7.0` tag does not.

To install the UX CLI, verify its downloaded checksum, Sigstore bundle, and GitHub
attestation against the same release workflow identity before running
`npm install -g ./jankurai-ux-qa-1.7.1.tgz`. Install the declared Playwright peer
dependency and Chromium as required by the package.

Releases and dependency tags are immutable. Roll back by explicitly selecting an
earlier verified release or opening a protected PR that restores a previously
accepted family lock. Preserve the existing GitHub release history and legacy
refs during all migrations.

## Release gate and recovery evidence

Release readiness requires successful component aggregates, the hub integration
artifact, and both platform jobs for the candidate. The release workflow repeats
integration before packaging; failed or missing evidence blocks publication.
Its security lane records an SBOM and checks secrets, dependencies, and workflow
permissions. Installer tests exercise checksum and provenance tampering; the
release smoke test must additionally verify actual downloaded signed assets on
both platforms before declaring the release usable.

Before creating the immutable tag, require a successful `release services` run
on Linux and Apple Silicon macOS. It signs a disposable text probe, exports the
real GitHub attestation, verifies both anonymously with the pinned tools, and
rejects modified content and wrong repository, workflow, source commit, and tag.
The workflow runs when its source or verifier setup changes on migration branches
or main, and supports manual dispatch. Its branch/workflow identity is separate
from release identity; its artifacts cannot satisfy the release installer.
This service check supplements the required signed native staging tests.
Download both `release-service-probe-*` artifacts from the successful run, keeping
one directory per artifact. From the exact main checkout that will be tagged, run
`node scripts/pre-tag-qualify.mjs <downloaded-run-directory> <run-id>`.
The command obtains the expected source from Git HEAD, checks the hosted run and
both successful platform jobs, then verifies private snapshots of both probes
with Cosign and GitHub CLI. Certificate fields must bind the expected repository,
workflow, source, run and attempt. Authored success messages cannot authorize
qualification. The returned receipt qualifies signing services; the complete
release candidate still needs its own signed native staging qualification before
tagging. Use Node24 and Cosign3.1.3, then install and select the pinned GitHub
verifier before invoking the command:

```sh
bash ops/ci/install-gh.sh
export PATH="${RUNNER_TEMP:-$PWD/target}/jankurai-ci-tools/bin:$PATH"
node scripts/pre-tag-qualify.mjs <downloaded-run-directory> <run-id>
```

Older GitHub CLI versions lack the required source-digest flags and are refused.

Build jobs use read-only tokens and upload unsigned assets. A fresh signing job
validates the complete unsigned inventory and signs it without building or
executing the candidate products. Separate read-only jobs verify the signatures
and run the staged native products on both supported platforms.

Enable GitHub immutable releases before creating the version tag. Publication resumes an
interrupted draft by matching each existing asset's uploaded state, size, and
SHA-256 digest against the verified candidate. It uploads only missing assets
and refuses conflicting, duplicate, or extra files, then publishes the complete
asset set as an immutable prerelease. A retry against a matching published
release performs verification only; it never overwrites assets or moves a tag.

Both public native smoke jobs must succeed before stable/latest promotion. The
promotion command reads GitHub's jobs for the exact workflow run and source
commit, requiring the latest execution of every named build, signing, verification,
staging, publication, and native smoke prerequisite. Failed or incomplete smoke leaves the
release as a prerelease. Retry failed jobs in the same run to reuse successful
prerequisites and the retained verified assets; an older success cannot override a
later failure. The promotion job must belong to the current attempt. Promotion
changes only the release flags and verifies that all asset IDs, sizes, and digests
remain unchanged. GitHub supports changing
these flags on an [immutable release](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository#editing-a-release).

Public native installation checks run before CI installs Node or verification
tools, with an empty credential environment and a PATH containing only documented
system utilities. They execute the README install command verbatim, run an audit,
verify the downloadable installer asset, install TUI, repeat installation, and
test removal. UX's Node/browser smoke runs separately afterward.

Backup custody consists of preserved Git refs, immutable dependency tags, prior
GitHub Releases, and a verified Git bundle before hub history migration. Record
the bundle digest and `git bundle verify` result in the migration evidence.
Rollback selects a prior verified release or restores accepted locks through a
protected PR; never move an existing release tag.

Monitoring uses required-check failures, uploaded audit findings, release job
status, and the hourly token-expiration job. Maintainers investigate failed
checks before another publication attempt. Abuse controls include read-only
build tokens, a hub-only publisher secret, bounded lock artifacts, exact-SHA
checks, protected PR merges, immutable tags, and fixed installer asset inventory.

The CI budget is bounded by workflow job timeouts and concurrency groups; the
updater runs once per hour and GitHub API rate limits bound its request quota.
Failure, token expiry, or exhausted quota is a stop condition. Disabling the
`family-update` workflow is the maintainer kill switch while investigating
unexpected workload. No workflow retries indefinitely or purchases extra quota.


### Recover an interrupted family update

Use `node scripts/family.mjs recover inspect --json`,
`bash scripts/family.sh recover inspect --json`, or `just recover-inspect` before
choosing `finish` or `rollback` (Just recipes: `recover-finish`, `recover-rollback`).
These paths run before lockfile parsing or npm bootstrap. They require Node24,
Git at `/usr/bin/git`, and the ordinary pinned Rust1.97.1 toolchain. The small
native helper compiles directly with rustc in a private temporary directory; it
uses no Cargo manifest, dependencies, network, or package bootstrap. It resolves
the exact host toolchain from the operating-system account's `.rustup`,
`/usr/local/rustup`, `/opt/rustup`, or `/opt/hostedtoolcache/rustup`. Repository
environment overrides do not select the compiler. Inspection reports compiler
availability and its digest; unavailable native capabilities block mutation.
The compiler, source and compiled helper identities are checked around execution.
Linux requires `renameat2(RENAME_EXCHANGE)`, and macOS requires
`renameatx_np(RENAME_SWAP)` on the checkout filesystem. Unsupported atomic
exchange or uncertain process identity refuses mutation.

Both before/after lock images and source identities are synced before replacement.
Recovery verifies their digests, the recorded source revision, and current lock
ownership. A live writer or another recovery process blocks recovery. Concurrent
lock edits are preserved; changed source or damaged images require inspection.
Successful completion moves the entire operation directory into
`.git/family-operation-history/`, preserving displaced files and unknown additions.
Keep this history and any refused operation for review; do not delete the active
operation or permanent `.git/family-recovery.lock` to bypass ownership checks.

Failed candidate validation preserves the candidate locks, accepted baseline and
available raw audit reports under `target/family-diagnostics/run-*` before its
temporary checkout is removed. Each directory has a manifest with file hashes
and the original failure; malformed or truncated report bytes remain available
as diagnostics. The updater uploads these directories on failure. They do not
grant proof coverage or establish a successful audit. If export fails, the
temporary candidate directory is retained and its path is reported for recovery.
