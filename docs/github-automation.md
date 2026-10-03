# GitHub family automation (retired)

GitHub is only a publishing mirror for the Jankurai family. The GitHub Actions
workflows that used to publish `ci-<sha>` tags, run the hourly `family-update`
job and rotate its token have been removed. Builds, CI, scoring and family lock
updates run on the forge and our own hosts; see
[forge-authority.md](forge-authority.md).

`scripts/family-update.mjs` and `scripts/publish-family-update.mjs` remain for
the local `scripts/family.sh` update path and their unit tests; nothing on
GitHub runs them.
