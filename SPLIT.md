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

## Required Local Check

```bash
bash scripts/ci-local.sh required
```
