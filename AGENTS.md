# jankurai Agent Instructions

Read `SPLIT.md` first. This repository is one member of the Jankurai split family.

- Authority: `root/jankurai` on `git.neverhuman.org`. Its `main` is the source of truth.
- Primary remote: `https://git.neverhuman.org/git/root/jankurai.git`.
- GitHub mirror: `neverhuman/jankurai-audit`. A mirror is never pushed to directly.
- Do not add committed cross-repo `path = "../..."` dependencies. Use the hub fusion workspace for local path patches.
- Do not hand-edit generated artifacts listed in `agent/generated-zones.toml`.
- Run `bash scripts/ci-local.sh required` before handing off changes.
