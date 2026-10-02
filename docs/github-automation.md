# GitHub family automation

The portable `repos.manifest.toml` declares the 15 repository identities, relative
checkout paths, GitHub URLs, default branches, and aggregate check names.
Component revision pins live only in `family.lock`; the assembled dependency
resolution lives in the committed aggregate `Cargo.lock`.

Each component publishes a lightweight `ci-<full commit SHA>` tag after its
`<repo>/required` GitHub Actions job succeeds on `main`. Tag rulesets prevent
updates and deletion. The hub also verifies that an eligible tag points to its
named commit, that the commit remains reachable from `main`, and that the exact
commit has a successful aggregate check produced by GitHub Actions.

The hourly `family-update` workflow tests candidate revisions in an automatically
removed standalone CI checkout. It executes the complete family checks and keeps
the accepted locks unchanged on failure. The resulting PR contains only
`family.lock` and `Cargo.lock`. A separate hourly merge job considers only the
expected automation actor, the content-derived `automation/family-*` branch name,
the same hub repository, the permitted changed files, eligible component pins,
and a successful `jankurai/required` check for the exact PR head. GitHub enforces
strict protected-branch checks and the merge API additionally binds the head SHA.
If main advances, publication refreshes the same content-derived PR with a new
commit that preserves its previous head and main as parents. The tree changes
only the two lockfiles relative to main, and normal PR CI runs again. Repeating
the same candidate against the same main creates no commit. Unexpected human
changes in an updater PR stop publication.
A later hourly run merges a candidate after normal PR CI has completed; the
PAT-authenticated merge triggers post-merge CI.

## Secret custody and rotation

`FAMILY_AUTOMATION_TOKEN` is a repository secret on **neverhuman/jankurai only**.
Only the trusted publication and merge jobs receive it. Build/test jobs receive
no supplied automation token; candidate subprocesses also strip token variables.
Candidate checkout, bootstrap, and checks run in the same sanitized child
process: GitHub/enterprise tokens, SSH agents and askpass helpers are removed,
Git system/global configuration and injected Git configuration are disabled,
and interactive Git authentication is refused. Collection's read-only API token
is used only outside that process to select eligible revisions.
Publication parses bounded lock artifacts and writes Git blobs through the API;
it never checks out or executes candidate component code with that token.

The hourly `rotation` job fails while `FAMILY_AUTOMATION_TOKEN_EXPIRES` is 14
or fewer whole days away. That failure is the closed path. Do not clear it by
raising the 14-day threshold, deleting the job, or writing a later date than the
new token actually expires. A missing, unpadded, or impossible date fails closed
and is never replaced with a default.

Maintainer rotation, in order:

1. Create a new personal access token for the same GitHub user that opens
   `automation/family-*` pull requests. The merge job trusts only that user's
   login. The token needs to read check runs on the locked family repositories
   and, on `neverhuman/jankurai` only, create blobs, trees, commits, and
   branches, open pull requests, and squash-merge them. Do not grant it to
   other repositories' secrets.
2. Copy the token's real expiry as `YYYY-MM-DD`. A fine-grained token's
   settings page shows that date. Do not round it forward.
3. On `neverhuman/jankurai`, open Settings, then Secrets and variables,
   then Actions. Replace the secret `FAMILY_AUTOMATION_TOKEN` with the new
   token. Set the repository variable `FAMILY_AUTOMATION_TOKEN_EXPIRES` to
   that same `YYYY-MM-DD`. The variable is not proof of rotation by itself.
4. Revoke the previous token after the new secret is saved. Do not paste the
   token into the repository, the variable, a workflow log, or this document.
5. Run `family-update` with `workflow_dispatch`. `rotation` must print
   `FAMILY_AUTOMATION_TOKEN rotation due <date>` and exit 0. `collect` then
   runs. If it opens a pull request, the diff may contain only `family.lock`
   and `Cargo.lock`. Wait for `jankurai/required` on that head. The later
   hourly merge job squashes it only when those gates pass.
6. Finish before the old token expires. After that date the old variable
   keeps the job red, which is the intended result.

A token-authenticated PR allows normal CI to run automatically, as described in
[GitHub's workflow trigger documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
