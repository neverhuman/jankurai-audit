# GitHub Action qualification

The proposed Action uses a full fresh audit and an additional score floor of
85 by default, configurable to 90. It preserves a stronger repository policy,
hard failures, ratchet failures, and any nonzero auditor exit. `fail-under: 0`
removes only the additional Action floor. It does not disable audit policy.

`fail-under` and `path` are supported inputs on
`neverhuman/jankurai-action` at and after `4a45526`. This hub release publishes
auditor `v1.7.1`. The immutable `neverhuman/jankurai@v1.7.0` Action has no
`fail-under` or `path` input. Do not retag it. Pass `release-tag: v1.7.1` until
the Action repository's default moves to that tag. The hosted `public-audit`
and `public-positive` jobs on `jankurai-action` are the consumer evidence for
this wrapper, and they must be re-run with `release-tag: v1.7.1` after this
release is promoted.
The installer continues to verify the explicitly selected auditor release.

The Action returns `report-json`, `report-md`, and `report-directory` paths
in a fresh private runner temporary directory. A consuming workflow may upload
`report-directory` with `if: always()` to retain evidence from failed audits.
A successful report cannot override a failed auditor process.

Before publishing, require hosted consumer checks at the proposed Action commit:
score 84 fails / 85 passes; configured 90 rejects 89; higher repository policy
wins; malformed or missing fresh reports and auditor failures fail the job.
Include a ratchet failure and the verified installer on each supported native
runner. Preserve existing source and installer trust and pin all test actions.
The released auditor still has the source/enforcement limitations tracked in
the release review; this wrapper does not qualify that producer by itself.
Updated local hooks also require a qualified producer with badge-write opt-out.

GitHub supports composite actions and this Action's `check-circle` / `green`
branding. Metadata validity alone is not Marketplace publication or qualification.
See [metadata syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax).
Before listing, verify the public repository's action-focused packaging, root
metadata, unique name, release validation and category. The owner must satisfy
the Developer Agreement and two-factor authentication requirements.
See [Marketplace publication](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace).

Gate input is limited to a regular report file of at most 32 MiB. If a report
includes a policy object, its numeric minimum_score must agree with the
decision floor. The gate supports the minimal decision contract when the policy
object is absent; it does not invent policy fields or validate the entire report schema.
