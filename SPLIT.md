# jankurai

Status: initial split-family extraction
Owner: Jankurai maintainers
Last reviewed: 2026-06-12
Applies to: jankurai

## Role

Public hub, installer, GitHub Action, family manifest, lock, and local fusion.

## Repositories

- Historical Jeryu repo: `root/jankurai`
- Primary GitHub repository: `neverhuman/jankurai`
- Release tag pattern: `v1.7.2`
- Source extraction commit: `cea83b0cbe204be276a2f0299cd760f6812ea2b0`

## Split Rules

- GitHub is authoritative; Jeryu refs are retained as historical inputs.
- Release builds depend on immutable GitHub tags, not branches.
- Local development uses the hub `scripts/fuse.sh` output under `.fusion/`.
- Committed manifests must not depend on sibling checkout paths.
- Generated outputs are regenerated from their source contracts or build commands.

## Family Auditor Pin

`agent/auditor-pin.toml` in this hub is the one auditor version the whole family
runs. `scripts/validate-family.mjs` fails, naming every repository that
disagrees, when a member checkout declares a different `auditor_version` in
`agent/standard-version.toml` or a different `release-tag` default in its
`action.yml`. Members are only checked when their checkout is present, so run
`bash scripts/validate-family.sh --checkouts` for the whole family.

Moving the pin is a release decision, and it does not change any live score by
itself: a person still has to re-cut and re-install the governed scorer the
forge runs (`jeryu/jankurai`), then record its `binary_sha256` in the pin file.
Until that measurement exists the field stays `pending`.

## Required Local Check

```bash
bash scripts/ci-local.sh required
```
