# jankurai Hub Architecture

`jankurai` is the public hub of the Jankurai split family. It is intentionally
thin: it carries the release installer, the published GitHub Action, the family
manifest and lockfile, the release notes, and the local fusion script. No
product source lives here — the auditor source lives in `jankurai-core` and the
reusable libraries live in the `jankurai-tools-*` family repos.

```text
hub (this repo)
  -> repos.manifest.toml   declares every family member
  -> ../repos.manifest.toml generated runtime projection; never authority
  -> family.lock           pins each member to an immutable tag + commit SHA
  -> scripts/fuse.sh        materializes a local .fusion/ workspace from members
  -> action.yml            installs the released binary and runs an audit
  -> jankurai-installer.sh  verifies + installs a released binary
```

## What the hub owns

| Path | Role |
| --- | --- |
| `repos.manifest.toml` | Sole protected family inventory: forge authority and GitHub mirror routes, paths, slugs, branches, checks, and roles. |
| `family.lock` | Pins each member repo to a release tag and commit SHA. |
| `scripts/` | Family validation, deterministic root-manifest projection, local fusion, and CI routing. |
| `ops/ci/` | Thin per-lane CI scripts shared by `just` and GitHub Actions. |
| `agent/` | Machine-readable owner/test/generated-zone maps and standard metadata. |
| `docs/` | Architecture, boundaries, testing, release, and exception doctrine. |
| `action.yml` | The published GitHub Action entrypoint. |
| `jankurai-installer.sh` | The release installer. |
| `assets/` | Published hub imagery referenced by the README. |

## Boundaries

There is no Rust crate, web surface, PostgreSQL database, or Python AI/data
service committed in this hub, so those stack arms of the family standard are
not applicable here. The prose boundary companion is
[`docs/boundaries.md`](boundaries.md).

## Generated zones

The hub never hand-edits generated output. The generated trees are `target/`
(local audit/CI state) and `.fusion/` (the fused workspace produced by
`scripts/fuse.sh`), both declared in
[`agent/generated-zones.toml`](../agent/generated-zones.toml) and ignored by
git.

## Ownership and proof

Agents should prefer [`agent/owner-map.json`](../agent/owner-map.json) and
[`agent/test-map.json`](../agent/test-map.json) for changes, then route to the
smallest proof lane: `just fast` (which runs `bash scripts/validate-family.sh`).
