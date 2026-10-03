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
GitHub Actions workflows: builds, CI and scoring run on the forge and our own
hosts, and `<repo>/required` on the forge is the gate. Releases are built and
signed on our servers; a separate change introduces key-based release signing.

The scripts behind the retired GitHub release path (`ops/ci/release-services.sh`,
`ops/ci/sign-release.sh`, `ops/ci/record-attestations.sh`,
`scripts/pre-tag-qualify.mjs`, `scripts/publish-ci-tag.mjs`,
`ops/ci/publish-release.mjs`, the `family-update` publishers) are still in the
tree and keep their unit tests, but nothing invokes them. They depend on
GitHub OIDC and are replaced by the new signing model.

## Release identity after the rename

The hub was renamed from `neverhuman/jankurai` to `neverhuman/jankurai-audit`
after v1.7.1 (the repository id is unchanged and the old name redirects).
Sigstore certificates record the name a workflow ran under and never change, so:

- v1.7.1 and earlier are signed as
  `https://github.com/neverhuman/jankurai/.github/workflows/release.yml@refs/tags/<tag>`,
  with source repository `https://github.com/neverhuman/jankurai`. Verified for
  v1.7.1: `gh attestation verify --repo neverhuman/jankurai` passes and
  `--repo neverhuman/jankurai-audit` fails with `expected SourceRepositoryURI`.
- v1.7.2, the last release signed by a GitHub workflow, is signed as
  `https://github.com/neverhuman/jankurai-audit/.github/workflows/release.yml@refs/tags/<tag>`.

The release guards name only the new repository: `ops/ci/release-services.sh`,
`scripts/pre-tag-qualify.mjs`, `ops/ci/publish-release.mjs`,
`ops/ci/package-release.mjs` (the provenance `repository`),
`scripts/publish-ci-tag.mjs` and `ops/ci/public-install-smoke.sh`. Two places
also accept the old name, explicitly:

- `jankurai-installer.sh` defaults to `neverhuman/jankurai-audit`. For either
  hub name it verifies tags up to v1.7.1 as `neverhuman/jankurai` and later tags
  as `neverhuman/jankurai-audit`; any other `--repo` verifies as itself.
- `ops/ci/verify-badge-source.mjs` accepts a retained badge record under either
  name, provided its run and job links name the same repository.

### Releases after v1.7.2

v1.7.2 was the last release signed by GitHub's keyless OIDC flow; its tag and
assets stay as published and the installer keeps verifying them under the
identities above. Later releases are built and signed on our servers with a
key we hold, introduced in a separate change.

`scripts/fixtures/pretag-gh-2.100.0.json` is retained verifier output from a
pre-rename probe. Its test parses it under the old identity and checks that
the current identity rejects it. It is a parser regression, not evidence.

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
