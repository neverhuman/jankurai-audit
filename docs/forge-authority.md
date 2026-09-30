# Forge authority and GitHub mirrors

Owner decision 2026-09-30: the Jankurai family's authority is the hosted forge.
`main` of each `root/<repo>` on `git.neverhuman.org` is the source of truth and
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

The old `neverhumanbot/jankurai-*` repositories cannot be transferred, so the
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

## GitHub Actions in the mirrors

A mirror must not go red merely because it is a mirror. `<repo>/required` on the
forge is the gate; the mirror's Actions are informational.

- `ci.yml` is mirror-safe: `fast`, `integration`, `release-build` and
  `jankurai/required` are read-only and use only `github.token`. They pass on a
  mirror unchanged.
- `ci.yml`'s `publish-ci-tag` job and every job in `family-update.yml` are now
  gated on `vars.JANKURAI_GITHUB_AUTHORITY == 'true'`. That variable is unset on
  a mirror, so those jobs are skipped instead of failing: CI tags and family
  update PRs belong on the forge.
- `release.yml` and `release-services.yml` are **not** mirror-safe and must be
  disabled in the mirror repositories (Actions → the workflow → Disable), and
  the forge's mirror push must not carry `v*` tags. Their identity guards and
  the recorded signing evidence they re-verify
  (`ops/ci/release-services.sh`, `scripts/pre-tag-qualify.mjs`,
  `ops/ci/publish-release.mjs`, `ops/ci/package-release.mjs`,
  `scripts/publish-ci-tag.mjs`) name `neverhuman/jankurai`. Re-pinning them to `neverhuman/jankurai-audit` needs
  fresh Sigstore evidence for the new repository identity and is follow-up work.

Version-pinned distribution URLs are unchanged for the same reason: the
`v1.7.1` release assets, the `raw.githubusercontent.com/.../v1.7.1` installer
line, `ops/ci/public-install-smoke.sh`, the schema `$id`s, and
`agent/badge-source/provenance.json` all identify artifacts already published
under the old name. They move with the first release cut from the mirror.

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
  which are the renamed, partly git-disabled `neverhumanbot` repositories. They
  must be repointed at `neverhuman/jankurai-audit-tools-*` at the same revs, the
  lockfiles regenerated, and the git `insteadOf` rewrite dropped from the
  `family.toml` setup hooks. The hub's fusion `[patch]` keys are generated from
  the manifest's `github` URLs, so they follow those `Cargo.toml` files and must
  be repointed in the same change set.
