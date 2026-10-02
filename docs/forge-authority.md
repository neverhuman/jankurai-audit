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

## GitHub Actions in the mirrors

A mirror must not go red merely because it is a mirror. `<repo>/required` on the
forge is the gate; the mirror's Actions are informational.

- GitHub-hosted runners cannot read the private forge. `ops/ci/github-setup.sh`
  therefore sets `JANKURAI_FAMILY_SOURCE=mirror`, so `scripts/family.sh setup`
  clones members and fetches their `ci-<sha>` pin tags from the public
  `neverhuman/jankurai-audit-*` mirrors, and it rewrites the members'
  pre-rename Cargo git sources (`github.com/neverhuman/jankurai-tools-*`, some of
  which no longer serve Git) to those mirrors (`scripts/family.sh
  mirror-routes`). Every pin is still checked against its locked commit. Off
  GitHub the default stays the forge. A pin tag missing from a mirror fails
  `ci.yml` `integration`, `release-build` and every `release.yml` job that
  builds.
- `ci.yml`'s `publish-ci-tag` job and every job in `family-update.yml` are
  gated on `vars.JANKURAI_GITHUB_AUTHORITY == 'true'`. That variable is unset on
  a mirror, so those jobs are skipped instead of failing: CI tags and family
  update PRs belong on the forge.
- `release.yml` and `release-services.yml` run on `neverhuman/jankurai-audit`
  and are pinned to that identity (see below). The forge's mirror push must not
  carry `v*` tags: a release starts only when the owner pushes the tag to
  GitHub.

## Release identity after the rename

The hub was renamed from `neverhuman/jankurai` to `neverhuman/jankurai-audit`
after v1.7.1 (the repository id is unchanged and the old name redirects).
Sigstore certificates record the name a workflow ran under and never change, so:

- v1.7.1 and earlier are signed as
  `https://github.com/neverhuman/jankurai/.github/workflows/release.yml@refs/tags/<tag>`,
  with source repository `https://github.com/neverhuman/jankurai`. Verified for
  v1.7.1: `gh attestation verify --repo neverhuman/jankurai` passes and
  `--repo neverhuman/jankurai-audit` fails with `expected SourceRepositoryURI`.
- v1.7.2 and later are signed as
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

### What "fresh Sigstore evidence" is

The only recorded signing evidence a guard re-verifies is the `release services`
probe: `release-services.yml` signs a one-line `probe.txt` on Linux and macOS
with keyless cosign, attests it with `actions/attest-build-provenance`, verifies
both anonymously, and uploads `release-service-probe-<os>` artifacts
(`probe.txt`, `probe.txt.sigstore.bundle`, `probe.txt.attestation.jsonl`).
`scripts/pre-tag-qualify.mjs` re-verifies those files and requires the
certificate SAN and build signer
`https://github.com/neverhuman/jankurai-audit/.github/workflows/release-services.yml@refs/heads/main`,
source repository `https://github.com/neverhuman/jankurai-audit`, source and
signer digest equal to the commit being tagged, ref `refs/heads/main`, a
GitHub-hosted runner, and the exact run and attempt. Probes are per commit, so
the evidence for one tag is always new.

No human signing step, key, secret, variable or ruleset is needed. Signing is
keyless through the workflow's OIDC token (`id-token: write`,
`attestations: write`), and the workflow produces its own evidence on its first
run under the new name. Before the re-pin every run failed at the repository
guard. The owner only has to start that run on the commit to be tagged and
download its artifacts (steps below).

`scripts/fixtures/pretag-gh-2.100.0.json` is retained verifier output from a
pre-rename probe. Its test parses it under the old identity and checks that
the current identity rejects it. It is a parser regression, not evidence.

The `v1.7.1` and earlier assets, their installer copies and
`raw.githubusercontent.com/.../v1.7.1` lines keep working through GitHub's
redirect for as long as no new repository takes the `neverhuman/jankurai` name.
The schema `$id`s are identifiers, not fetch locations, and are unchanged.

## Releasing v1.7.2 from the mirror

The release is cut on GitHub because the signing identity is a GitHub workflow.
The forge stays the source: the tag must name a commit that the forge's `main`
already has and that the mirror has copied to GitHub `main`.

1. Land the release changes on forge `main` and wait for the mirror to update
   GitHub `main`: `git ls-remote https://github.com/neverhuman/jankurai-audit.git
   refs/heads/main` must print the forge `main` commit. Use that commit below
   as `HEAD_SHA`.
2. Make every pin tag in the merged `family.lock` exist on the forge and the
   mirror. Read the shas from that file, not from a PR, because a rebasing merge
   changes commits. For each member whose `<member>/required` passed at its
   pinned commit and whose tag is missing, push the tag to the forge from a
   checkout of that member that has the commit:

       sha=<commit from family.lock>
       git push origin "$sha:refs/tags/ci-$sha"

   The mirror copies non-`v*` tags it lacks. Confirm each one with
   `git ls-remote https://github.com/neverhuman/jankurai-audit-<x>.git
   refs/tags/ci-$sha`. Push the same ref straight to the GitHub mirror only if
   the mirror has not copied it.
3. Start the signing probe on that commit: Actions → `release services` → Run
   workflow on `main` (or `gh workflow run release-services.yml --repo
   neverhuman/jankurai-audit --ref main`). Wait for both `verify` jobs to pass.
4. Qualify it locally from a clean checkout of `HEAD_SHA`, using Node 24, cosign
   3.1.3 and the pinned GitHub CLI:

       gh run download <run-id> --repo neverhuman/jankurai-audit --dir <dir>
       bash ops/ci/install-gh.sh
       export PATH="$PWD/target/jankurai-ci-tools/bin:$PATH"
       node scripts/pre-tag-qualify.mjs <dir> <run-id>

   It must print `"ok": true`. If `main` moved after the run, run it again.
5. Optional dry run: Actions → `ci` → Run workflow on `main` shows
   `integration` and both `release-build` jobs passing before any tag exists.
6. Tag and push to GitHub only. The push triggers `release.yml`:

       git tag -a v1.7.2 -m "Jankurai 1.7.2" "$HEAD_SHA"
       git push https://github.com/neverhuman/jankurai-audit.git refs/tags/v1.7.2

7. Watch `release` through `promote`. A failed job is re-run in the same run;
   never move or delete the tag.
8. Push the same tag object to the forge so both sides agree:
   `git push origin refs/tags/v1.7.2`.
9. Check from a clean machine: `bash jankurai-installer.sh --tag v1.7.2
   --verify-only`, and the same with `--tag v1.7.1`, which must still verify
   under the old identity.

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
