# Forge authority and GitHub mirrors

The Jankurai family's authority is the hosted forge.
`main` of each `root/<repo>` on the forge is the source of truth and
what gets deployed. `github.com/neverhuman/*` is a mirror of it.

`repos.manifest.toml` (schema 3.0.0, the authority manifest in this hub) records
both sides: `authority_forge = "jeryu"`, `hosted`/`slug`/`jeryu_slug` on the
forge, `github`/`github_slug` on the mirror, and `mirror_github` /
`mirror_github_main` so the forge enrolls each member. `bash
scripts/validate-family.sh` rejects a manifest that names GitHub as the
authority, that routes `hosted_*` at github.com, or that stops mirroring.

## What the forge must add to `split_manifests`

The forge reads one manifest to enroll the whole family:

    repository: root/jankurai
    branch:     main
    path:       repos.manifest.toml

i.e. `root/jankurai:repos.manifest.toml` at `refs/heads/main`. The same file is
`jankurai/repos.manifest.toml` relative to a split workspace root, which is the
value of the manifest's own `authority_manifest` field. The generated
workspace-root projection (`repos.manifest.toml` beside the hub, produced by
`scripts/project-family-manifest.sh --apply`) is a convenience copy and must not
be configured as the authority.

The fields jeryu's mirror reads (`crates/jeryu-api/src/github_mirror.rs`) are
present on every `[[repo]]`: `github_slug`, `jeryu_slug`, `mirror_github_main`.

## Mirror names

The older personal-account `jankurai-*` repositories cannot be transferred, so the
org mirror carries the hub's prefix:

| forge | GitHub mirror |
| --- | --- |
| `root/jankurai` | `neverhuman/jankurai-audit` |
| `root/jankurai-action` | `neverhuman/jankurai-action` (published Action name kept) |
| `root/jankurai-<x>` | `neverhuman/jankurai-audit-<x>` |

`[mirror_repo_override]` in the manifest holds the Action exception.

`slug` is the forge identity, so everything that talks to the GitHub API uses
`github_slug` instead (`scripts/provision-family.mjs`,
`scripts/family-update.mjs`, `scripts/publish-family-update.mjs`). Bootstrap
clones, pin fetches and the `origin` remote use `hosted`; a checkout whose
`origin` still points at GitHub is renamed to the `github` remote.

## jankurai-action is mirrored, not a member

The family has 16 repositories but `expected_repo_count` is 15.
`jankurai-action` publishes the composite Action and carries no split-member
metadata (`SPLIT.md`, `agent/*.json`, `agent/generated-zones.toml`,
`ops/ci/required.sh`) and no `family.lock` pin, so it cannot satisfy the member
contract that `validate-family.sh` enforces. It is declared as
`[[mirror_only_repo]]`: the forge mirrors it, and it stays outside the fused
build and the lock. Promoting it to a member means adding that metadata and a
`ci-<sha>` pin first.

## GitHub is a publishing mirror

GitHub is only a publishing destination for this family. The mirrors carry no
GitHub Actions workflows. Builds, CI and scoring run on the forge and our own
hosts, and `<repo>/required` on the forge is the gate. Releases are built on our
build hosts, signed with a release key we hold, and uploaded to the hub mirror's
GitHub Releases by the owner. [release.md](release.md) has the owner steps, and
`ops/release/` holds the tooling.

The scripts that served only the GitHub workflow release path are deleted:

- keyless signing for new releases: `ops/ci/sign-release.sh`, `ops/ci/release-sign-blob.sh`
- attestation export: `ops/ci/record-attestations.sh`, `ops/ci/verify-release-signatures.sh`
- the signing-service probe and its pre-tag qualifier: `ops/ci/release-services.sh`,
  `scripts/pre-tag-qualify.mjs` and its fixture, `ops/ci/install-gh.sh`
- Actions-driven CI tags: `scripts/publish-ci-tag.mjs`
- the workflow publish, promote and smoke jobs: `ops/ci/release-publish.sh`,
  `ops/ci/release-smoke.sh`, `ops/ci/release-build.sh`, `ops/ci/release-macos-sign.sh`

Packaging, inventory checks, staged verification and publication moved to
`ops/release/` in key-signed form. What stays is what verifying v1.7.1 and
earlier still needs: the installer's keyless path, with its pinned GitHub CLI,
cosign and jq. The `family-update` publishers are a separate path and are
unchanged here.

## Release identity after the rename

The hub was renamed from `neverhuman/jankurai` to `neverhuman/jankurai-audit`
after v1.7.1 (the repository id is unchanged and the old name redirects).
Sigstore certificates record the name a workflow ran under and never change, so
v1.7.1 and earlier are signed as
`https://github.com/neverhuman/jankurai/.github/workflows/release.yml@refs/tags/<tag>`,
with source repository `https://github.com/neverhuman/jankurai`. Verified for
v1.7.1: `gh attestation verify --repo neverhuman/jankurai` passes and
`--repo neverhuman/jankurai-audit` fails with `expected SourceRepositoryURI`.
`jankurai-installer.sh` verifies those tags as `neverhuman/jankurai` whichever hub
name is requested. Any other `--repo` verifies as itself.

### Key-signed releases from v1.7.2

No GitHub workflow ever signed v1.7.2, and none will: no keyless evidence exists
for it. v1.7.2 is the first release built on our servers and signed with the
release key (`release-keys/jankurai-release-2026.pub`, pinned by SHA-256 in the
installer's `release_keys` table). Every later tag follows it. For these tags the
installer requires `<asset>.sha256` and `<asset>.cosign.bundle`, verified against
the pinned key, plus provenance schema `jankurai.release/v2` naming
`https://github.com/neverhuman/jankurai-audit`, the tag, commit and tree. It
needs no GitHub attestation and fetches no GitHub CLI. The tag `v1.7.2` itself is
unchanged. Only its release assets are new.

`ops/ci/verify-badge-source.mjs` still accepts a retained badge record under
either hub name, provided its run and job links name the same repository.

The `v1.7.1` and earlier assets, their installer copies and
`raw.githubusercontent.com/.../v1.7.1` lines keep working through GitHub's
redirect for as long as no new repository takes the `neverhuman/jankurai` name.
The schema `$id`s are identifiers, not fetch locations, and are unchanged.

## Still to land in the member repositories

This hub change cannot edit the members. Each `root/jankurai-*` main still
needs, as its own change:

- `agent/split-member.toml`: `authority_forge = "jeryu"`, `primary_repo =
  "root/<repo>"`, `mirror_repo = "neverhuman/jankurai-audit-<x>"`.
- `AGENTS.md`, `README.md`, badges and docs: forge authority, mirror links.
- Cargo git routes: `jankurai-core`'s
  `[patch."https://github.com/neverhuman/jankurai-tools-kernel.git"]` and the
  `Cargo.lock` sources in `jankurai-core`, `jankurai-tools-analyzers`,
  `jankurai-tools-dedup` and `jankurai-tools-fleet` still name
  `github.com/neverhuman/jankurai-tools-{kernel,dedup,analyzers,fleet,guard,proof}`,
  which are the older, partly git-disabled personal-account repositories. They
  must be repointed at `neverhuman/jankurai-audit-tools-*` at the same revs, the
  lockfiles regenerated, and the git `insteadOf` rewrite dropped from the
  `family.toml` setup hooks. The hub's fusion `[patch]` keys are generated from
  the manifest's `github` URLs, so they follow those `Cargo.toml` files and must
  be repointed in the same change set.
