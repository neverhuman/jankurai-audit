# Release process

Releases are built and signed on our own build hosts and published to GitHub,
which is only the publishing mirror. Nothing runs on GitHub Actions. `VERSION`,
the auditor version, the Tuiwright version and the UX npm package version must
agree. The current release is `v1.7.2`. It is the first key-signed release.

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

### Every release

The tag must already exist on the forge and on the GitHub mirror. Tags are
immutable. Never move one.

```sh
tag=v1.7.2
git fetch origin --tags
# 1. Build (Linux x86-64). A neutral build root keeps home paths out of the binary.
ops/release/build-release.sh --tag "$tag" --workdir "/srv/jankurai-release/$tag-x86_64-unknown-linux-gnu" \
  --out "target/release-dist/$tag"
# 2. Optional: Apple Silicon macOS, built on a macOS build host over SSH.
ops/release/build-darwin-remote.sh --host <macos-build-host> --tag "$tag" --dist "target/release-dist/$tag"
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

**Build** (`ops/release/build-release.sh`). This tooling checkout clones the
hub at the tag into a fresh build tree. `compose-source.mjs` clones every member
beside it at its `family.lock` tag, and each tag must resolve to its locked
commit. Members come from the forge using your Git credentials, or from the
GitHub mirror with `--members mirror`. Then the tag's own
`scripts/family.sh build --release --target <triple>` builds the release, the
tag's native family-operation tests run, and a check confirms every tree is
still clean and at its pin. Cross builds are refused, so each target builds on
a host of that platform.

**Reproducibility.** `SOURCE_DATE_EPOCH` is the tag's commit time. Rust paths are
remapped (`--remap-path-prefix` for the build tree, Cargo home and sysroot).
Tarballs are ustar with sorted entries, root ownership, fixed modes and mtimes,
and gzip without a timestamp. Provenance has no timestamps or host names. Two
builds at the same build root produce byte-identical assets. `tuiwright` and
every other asset are also identical across different build roots. `jankurai`
embeds its crate directory (`CARGO_MANIFEST_DIR`, used by `jankurai-core`), so
reproducing it needs the same build root. Provenance records that root as
`build_root`.

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
bash -o pipefail -c 'curl --proto "=https" --tlsv1.2 -fsSL https://github.com/neverhuman/jankurai-audit/releases/download/v1.7.2/jankurai-installer.sh | bash -s -- --tag v1.7.2'
bash jankurai-installer.sh --tag v1.7.2 --product tuiwright
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
