# ops Agent Instructions

This cell owns the hub's CI and operational surface. Read the root
[`AGENTS.md`](../AGENTS.md) and [`SPLIT.md`](../SPLIT.md) first.

## Owns

- `ops/ci/*.sh` — thin per-lane CI scripts (`fast`, `security`, `audit`,
  `tool-adoption`, `required`, `quality-gates`) sourced by both
  `scripts/ci-local.sh` and forge CI on our own hosts. GitHub is a publishing
  mirror and runs no workflows for this repository.
- `ops/ci/lib.sh` — shared tool-version pins and artifact assertions; the single
  source of truth so local runs and CI execute the same commands.
- `ops/release/` — owner-run release tooling: build on our hosts, sign with the
  release key, verify, publish to the GitHub mirror (see `docs/release.md`).
  `release-keys/` holds the public keys the installer pins.
- `ops/git-hooks/pre-push` — the mandatory pre-push gate; wire it with
  `git config core.hooksPath ops/git-hooks`.

## Forbidden

- Do not add GitHub Actions workflows; CI calls `bash ops/ci/<lane>.sh` on the
  forge and our own hosts so CI and local stay identical.
- Do not unpin a third-party action in the shipped `action.yml`. Every `uses:`
  is pinned to a 40-character commit SHA.
- Never commit, print, copy into CI, or hand to an agent the release signing
  private key or its password; never generate the production key for the owner.
- Do not hand-edit generated zones listed in
  [`agent/generated-zones.toml`](../agent/generated-zones.toml).

## Proof lane

Run the security lane and family validation before handing off ops changes:

```bash
bash ops/ci/security.sh
bash scripts/validate-family.sh
```

The narrowest gate is `just fast`; the full gate is `just check`.
