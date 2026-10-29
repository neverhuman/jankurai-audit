# Release process

Releases are built and signed on our own build hosts and published to GitHub,
which is only the publishing mirror. Nothing runs on GitHub Actions. `VERSION`,
the auditor version, the Tuiwright version and the UX npm package version must
agree. The current release is `v1.7.5`. `v1.7.2` was the first key-signed release.

| Tags | Built by | Signed with | The installer verifies |
| --- | --- | --- | --- |
| v1.7.2 and later | our build hosts (`ops/release/`) | the release key we hold (cosign) | `.sha256` and a key signature against the pinned public key |
| v1.7.1 and earlier | GitHub Actions `release.yml` | Sigstore keyless (workflow OIDC) | `.sha256`, the workflow identity, and the GitHub attestation |

## Owner steps

Run these on the signing host from a clean hub checkout of `main`. The private
key stays on that host. An agent never handles it.

### Once per key: generate it and commit the public half

```sh
ops/release/generate-signing-key.sh            # prompts for the key password
# private key: ~/.config/jankurai-release/jankurai-release-2026.key (mode 600)
git switch -c release-key-2026
ops/release/install-public-key.sh ~/.config/jankurai-release/jankurai-release-2026.pub
git commit -am 'release: pin the 2026 release signing key' && git push   # open a PR
```

`install-public-key.sh` replaces the placeholder `release-keys/jankurai-release-2026.pub`
and writes its SHA-256 into the `release_keys` table in `jankurai-installer.sh`.
Until that PR merges, the pin is all zeros. Signing refuses to run and the
installer refuses every key-signed tag. Back up the private key and its password
offline, in separate places.

### Prepare release notes before tagging

The release preparer generates notes with Git, using the previous published
release tag and the commit that will be released. For example, to prepare the
next release from the current checkout:

```sh
previous_tag=v1.7.5
next_version=1.7.6
git rev-parse --verify "refs/tags/$previous_tag^{commit}"
mkdir -p target/release-notes
{
  printf '## %s\n\n' "$next_version"
  git log --reverse --no-merges --format='- %s%n%(trailers:key=Todo)' "$previous_tag..HEAD"
} > "target/release-notes/$next_version.md"
```

Review the generated file, including rollback commits and compatibility changes,
then insert that version block into `CHANGELOG.md` in the release preparation
PR. Preserve existing historical entries and any pending `Unreleased` notes;
carry pending notes into the release they describe. Contributors supply clear
commit subjects and `Todo:` trailers, without per-change changelog edits. The
command above is the generation step; the build and publisher do not run it.

### Every release

The tag must already exist on the forge and on the GitHub mirror. Tags are
immutable. Never move one.
The release preparation PR above must already have landed before the tag is cut.

```sh
tag=v1.7.5
git fetch origin --tags
# 1. Build (Linux x86-64) in one registered host-managed source worktree.
#    The compile runs in the digest-pinned Debian 12 image of ops/release/builder
#    (needs Docker), so the binaries need at most glibc 2.36; the provenance
#    records the image. Git and crates.io sources are fetched on the host.
ops/release/build-release.sh --tag "$tag" --expect-commit "$(git rev-parse "refs/tags/$tag^{commit}")" \
  --out "target/release-dist/$tag"
# 2. Optional: Apple Silicon macOS, built on a macOS build host over SSH.
ops/release/build-darwin-remote.sh --host <macos-build-host> --remote-repo /jankurai/repository --tag "$tag" --dist "target/release-dist/$tag"
# 3. Sign (cosign 3.1.3 on PATH or in $COSIGN).
JANKURAI_RELEASE_SIGNING_KEY=~/.config/jankurai-release/jankurai-release-2026.key \
JANKURAI_RELEASE_SIGNING_PASSWORD_FILE=~/.config/jankurai-release/password \
  ops/release/sign-release.sh --dist "target/release-dist/$tag" --tag "$tag"
# 4. Verify, then install and run through the installer, before anything is public.
ops/release/verify-staged-release.sh --dist "target/release-dist/$tag" --tag "$tag"
# 5. Publish to the GitHub mirror: dry run first, then for real.
ops/release/publish-github-release.sh --tag "$tag" --dist "target/release-dist/$tag" --dry-run
ops/release/publish-github-release.sh --tag "$tag" --dist "target/release-dist/$tag" \
  --token-file ~/.config/jankurai-release/github-token
# 6. Check the public release as an anonymous user would.
RELEASE_TAG="$tag" bash ops/ci/public-install-smoke.sh
bash jankurai-installer.sh --tag v1.7.1 --verify-only   # older keyless releases still verify
```

The GitHub token is a fine-grained token with `contents: write` on
`neverhuman/jankurai-audit` only. Keep it in a mode-600 file. The publisher reads
it from that file and never prints it. A dry run makes no writes. Given
`--token-file`, it uses the token for its reads only.

## What each step does

**Build** (`ops/release/build-release.sh`). The local source repository must
already contain the immutable tag and current `origin/main`. `--expect-commit`
is mandatory. The builder runs the host lane sweep, refuses more than eight
lanes, and creates one locked, detached source worktree under the hub repository's
`.agent/worktrees/release-<tag>-<target>`. It never reuses an existing lane.
Build output stays in that lane's `target/`; a custom `--workdir` must stay there.
The host must already provide its operator-managed `~/.agent/bin/lanes` helper.
Its `sweep --apply` operation removes eligible idle lanes according to the host's
custody policy before capacity is checked; inspect that host policy before release
work. The repository does not install or replace this privileged host dependency.

`compose-source.mjs` fetches real member tags and main into fresh bare object
stores, checks every locked commit and main ancestry, then exports complete
tracked blobs into `target/release-members`. These are generated compilation
inputs, not Git checkouts: no member clones or additional worktrees are made.
Symlinks and submodules are refused. The tag's own fusion generator and build
implementation consume those verified inputs. Tracked bytes and executable
modes are checked before and after building, and extra files outside build
output directories are refused. Member sources default to the forge; use
`--members mirror` for the public mirror or a local checkout root as an object
source. Cross builds remain refused. Native family-operation tests still run.

The source lane stays locked with all build evidence after success or failure.
Before cleanup, record `git status`, `git stash list`, local-only commits and
local/remote tags, bundle any unique refs, and verify the bundle. Inspect and
preserve `target/` and `.fusion/` (binaries, object inputs, receipts and reports)
to the release evidence directory before removing the worktree. Then use
`git worktree unlock <source-lane>` and `git worktree remove <source-lane>` from
the primary repository. Never delete a failed build tree blindly or use
`rm -rf` for worktree cleanup. Reuse the retained target if resuming that lane;
a fresh source allocation deliberately refuses to overwrite it.

**Reproducibility.** `SOURCE_DATE_EPOCH` is the tag's commit time. Linux compilation
mounts the registered source lane at `/jankurai/source` and the tooling at
`/jankurai/tooling`. Cargo home and the builder account home are also below that
neutral source mount. Rust paths are remapped (`--remap-path-prefix` for the
build tree, Cargo home and sysroot).
Tarballs are ustar with sorted entries, root ownership, fixed modes and mtimes,
and gzip without a timestamp. Provenance records the source commit time and OS
platform, but no wall-clock build time, host name or private host checkout path.
`jankurai` embeds its crate directory (`CARGO_MANIFEST_DIR`, used by
`jankurai-core`); path remapping alone cannot normalize that environment literal.
The stable container mount makes it independent of the host's repository path,
and provenance records `build_root: /jankurai` for Linux container builds.
Native builds cannot remount the source: they require the existing primary hub
at `/jankurai/repository`, with its registered source lane beneath
`.agent/worktrees/`. Other native roots fail before a source lane is allocated,
so private paths cannot silently enter a published native asset. Reproduction
uses the same tag, target, toolchain, neutral path and release tooling revision.

**Packaging** (`ops/release/package-release.mjs`). It keeps the asset names and
tarball layout the installer has always checked:

- `jankurai-<version>-<target>.tar.gz` and `tuiwright-<version>-<target>.tar.gz`,
  each holding only the executable, `LICENSE`, `family.lock`, `Cargo.lock` and
  `provenance.json`
- `jankurai-ux-qa-<version>.tgz`, `family.lock`, `Cargo.lock`, `jankurai-installer.sh`
  and `provenance-<target>.json`
- `<asset>.sha256` for each of them

Provenance is schema `jankurai.release/v2`. It records `version`, `tag`,
`target`, `repository`, the source `commit` and `tree`, `source_date_epoch`,
`build_root`, the lock digests, every member commit, the full toolchain
(`rustc -vV`, cargo, node, npm), the build platform, and the release tooling
commit plus the SHA-256 of the installer it shipped. It has no GitHub workflow
or attestation fields.

**Targets.** Linux x86-64 is required. Apple Silicon macOS
(`aarch64-apple-darwin`, shipped through v1.7.1) is optional. It needs a macOS
build host with git, rustup, Node.js with npm, and read access to the members.
`build-darwin-remote.sh` sends that host one Git bundle with the tooling commit
and the tag, builds there, and copies back only the darwin files. The private
key never goes to the macOS host. Linux ARM64 is not built: the installer does
not support it, and no cross toolchain is provisioned. If darwin is skipped, the
release ships Linux only, and the installer on Apple Silicon fails to download
the asset instead of installing something unverified.

**Signing** (`ops/release/sign-release.sh`). It runs
`cosign sign-blob --key <key> --bundle <asset>.cosign.bundle` on every asset,
including provenance, the locks, the installer and the UX package. Each output is
a Sigstore bundle (v0.3) that holds only the key signature, and it verifies
offline. We use a bundle rather than a detached `.sig` because it is one
self-describing file and a later opt-in transparency-log entry fits in the same
format. The script fails closed in these cases:

- the key path is missing, a symlink, not owned by you, readable by group or others, or inside a Git work tree
- there is no password (`COSIGN_PASSWORD` or a mode-600 `JANKURAI_RELEASE_SIGNING_PASSWORD_FILE`)
- cosign is not the pinned upstream 3.1.3 binary
- the key's public half is not the key the installer pins for that tag
- the unsigned inventory is incomplete

It then adds the public key file to the inventory and verifies everything it
signed.

**No transparency log by default.** Signing passes `--use-signing-config=false
--tlog-upload=false`, so nothing goes to the public Rekor log. Verification uses
`--insecure-ignore-tlog=true --offline=true`, so it needs no network. Setting
`JANKURAI_RELEASE_TLOG_UPLOAD=1` uploads the signatures to Rekor as an explicit
owner opt-in. The installer accepts either form. See [SECURITY.md](../SECURITY.md#release-signing).

**Inventory checks** (`ops/release/verify-release-assets.mjs`). A release holds
exactly the products, their `.sha256` and `.cosign.bundle` companions, and the
one public key the installer pins for the tag. Darwin files must be complete if
any are present. Links, special files and unexpected names are refused.

**Publication** (`ops/release/publish-github-release.sh`). It refuses to run
unless the inventory verifies offline. The steps:

1. Read the source commit, which all provenance files must agree on.
2. Check that the GitHub tag names that commit.
3. Create a draft release, or resume a matching draft.
4. Upload only the missing assets.
5. Check every uploaded asset's size and SHA-256 digest against the local files.
6. Re-check the tag.
7. Publish the release as latest, or not with `--no-latest`.

A published release whose assets match is a no-op. Any conflicting, extra or
replaced asset is refused, and nothing is ever overwritten. Enable GitHub
immutable releases on the mirror so published assets cannot change afterwards.

## Release automation

### Release gate and retained evidence

Before creating a public release, retain the following evidence under
`target/release-evidence/<tag>/` and copy it to the release backup with the
unsigned/signed dist inventory. A successful command alone is not evidence
that later signing or publication happened.

1. Record `git rev-parse HEAD`, `git status --porcelain`, and the forge PR URL.
   Require a clean merged source, green exact-head required CI and independent
   review. Run `bash scripts/ci-local.sh required` and save its complete log.
2. Run `bash scripts/ci-local.sh security` and retain the redacted scan log,
   npm audit result and `target/jankurai/security/sbom.json`. Stop on failure.
3. Run `bash scripts/ci-local.sh audit` with the governed auditor and retain
   `.jankurai/repo-score.json` and `.md`. Inspect the decision and findings;
   an advisory audit exit alone does not authorize release.
4. Record `git ls-remote origin refs/tags/<tag>` and its GitHub mirror result.
   Both must identify the reviewed source. Backup refs and the previous signed
   release inventory before starting. Private-key backup custody belongs to
   the owner and is never part of the agent's evidence directory.
5. Build with a bounded command, for example
   `timeout --signal=TERM --kill-after=60s 2h ops/release/build-release.sh --tag "$tag" --expect-commit "$(git rev-parse "refs/tags/$tag^{commit}")" --out "target/release-dist/$tag"`.
   Retain the build log, provenance and checksums. Check free disk first; stop
   below 20 GiB available. One active build per host is the resource quota.
6. After owner signing, save the output of `verify-staged-release.sh`, the
   publisher dry run and publication. These exercise archive integrity,
   signatures, inventory, installer and the native binaries before publication.
7. For monitoring after publication, retain `ops/ci/public-install-smoke.sh`
   output using `RELEASE_TAG="$tag"`. A failed anonymous install blocks host
   promotion. Inspect the installed version and signed-install receipt on each
   consuming host after its governed promotion.

Abuse controls are enforced by the publisher's refusal to overwrite assets,
the installer's pinned key and archive validation, and the scoped GitHub token.
On rate limit or authentication failure stop the run; do not rotate credentials
or run a retry loop. Rollback selects the previous verified release and its
receipt through the same governed installer; never rewrite tags or replace
published assets. Preserve the failed release's evidence for diagnosis.

There is none on GitHub. Pins in `family.lock` are immutable `ci-<sha>` tags. A
release starts only when the owner runs the steps above. The gate for every
change is the forge's `<repo>/required` check. Before tagging, run the full
locked-family check (`just check`) on a build host.

Rollback means selecting an earlier verified release, or opening a protected PR
that restores a previously accepted family lock. Never move a release tag or
replace published assets. Backup custody consists of the forge's Git refs,
immutable dependency tags, the published GitHub releases, and an offline copy of
the release signing key.

## Rotating or revoking the signing key

Rotate by adding a key, never by replacing one in place.

1. Generate the new key with `generate-signing-key.sh --name jankurai-release-<year>`.
2. In `jankurai-installer.sh`, close the old entry's range at the last tag it
   signed (`...|v1.7.2|v1.9.4`) and append
   `jankurai-release-<year>.pub|<zeros>|v1.9.5|`.
3. Run `install-public-key.sh` for the new key and merge the PR before tagging v1.9.5.

Old releases keep verifying with the key that signed them. If a key is
compromised, publish a fixed installer whose table no longer accepts that key
for the affected tags, then re-sign those tags' assets with the new key, or
withdraw them. Exactly one key may cover any tag. Overlapping or missing
coverage is refused.

## Installation

```sh
bash -o pipefail -c 'curl --proto "=https" --tlsv1.2 -fsSL https://github.com/neverhuman/jankurai-audit/releases/download/v1.7.5/jankurai-installer.sh | bash -s -- --tag v1.7.5'
bash jankurai-installer.sh --tag v1.7.5 --product tuiwright
```

The installer downloads temporary cosign and jq binaries at exact versions and
checks their embedded SHA-256 pins. Keyless releases also need GitHub CLI.
No GitHub login is required.

For v1.7.2 and later, the installer checks these, in order:

1. the downloaded public key against its pinned SHA-256
2. the asset checksum
3. the key signature
4. the archive inventory and file types
5. the provenance schema, tag, version, target, repository, commit and tree
6. the embedded lock digests

For v1.7.1 and earlier, it keeps the keyless checks unchanged. Both paths run the
staged binary before replacing an installed one. `--verify-only` does all of
that without installing. `--assets-dir <dir>` verifies a local staged inventory
under the same policy.

The installer copy in the v1.7.2 tag predates key signing. Fetch the installer
from the release assets, as above, or from `main`.

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
