# jankurai Agent Instructions

Read `SPLIT.md` first. This repository is one member of the Jankurai split family.

- Authority: `root/jankurai` on the hosted forge. Its `main` is the source of truth.
- Primary remote: the `hosted` URL of the `jankurai` entry in `repos.manifest.toml`.
- GitHub mirror: `neverhuman/jankurai-audit`. A mirror is never pushed to directly.
- Do not add committed cross-repo `path = "../..."` dependencies. Use the hub fusion workspace for local path patches.
- Do not hand-edit generated artifacts listed in `agent/generated-zones.toml`.
- `agent/auditor-pin.toml` is the family's single auditor version. Never edit a member's `auditor_version` or `release-tag` default to disagree with it; move the pin instead (see `SPLIT.md`).
- Run `bash scripts/ci-local.sh required` before handing off changes. `contracts/gate-contract.md` defines what that command owns in every member; check a lane surface with `bash scripts/validate-family.sh --gate-contract`.
