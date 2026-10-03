# Security Policy

## Supported Versions

Security fixes target `main` and the latest published release, currently
[v1.7.2](https://github.com/neverhuman/jankurai-audit/releases/tag/v1.7.2). Older
snapshots are supported only when maintainers explicitly mark them in release notes.

## Private Reporting

Do not open a public issue for suspected vulnerabilities.

Use GitHub private vulnerability reporting:

https://github.com/neverhuman/jankurai-audit/security/advisories/new

If that path is unavailable, contact a maintainer privately through GitHub before publishing details.

## What To Include

Include enough detail for maintainers to reproduce and scope the issue:

- affected command, file, workflow, or generated artifact,
- repository shape needed to trigger the issue,
- proof of impact,
- whether secrets, credentials, private code, or prompt transcripts were exposed,
- suggested fix or mitigation, if known.

Do not include live credentials, customer data, or private prompt transcripts in the report. Redact sensitive values and state what was redacted.

## Handling

Maintainers will triage private reports, assign severity, and decide whether a GitHub Security Advisory, CVE request, or coordinated disclosure is needed. Fixes should include a narrow proof lane and, when relevant, a changelog entry.

## Security Proof Lanes

Security-sensitive changes should run:

```bash
just security
cargo test -p jankurai
git diff --check
```

Use `just security-strict` when changing secret scanning, dependency checks, prompt-injection policy, generated-zone handling, file writes, shell execution, CI permissions, or advisory behavior.

## Release Signing

v1.7.2 and later are built on our own build hosts and signed with a cosign key
pair we hold. v1.7.1 and earlier were signed by GitHub Actions with Sigstore
keyless signing. The installer picks the scheme by tag.

**Key custody.** The private key is created by the owner on the signing host
with `ops/release/generate-signing-key.sh`, with a password cosign prompts for.
It lives outside every Git repository in a mode-700 directory, as a mode-600
file. The suggested location is `~/.config/jankurai-release/`. An offline backup
of the key and, separately, its password is the recovery path. The key is never
committed, never passed to an agent, never copied to a build host that does not
sign, and never put in CI. `sign-release.sh` refuses a key that is missing, a
symlink, not owned by the caller, readable or writable by group or others, or
inside a Git work tree. It also refuses a key whose public half is not the one
the installer pins for the tag.

**Distribution and rotation.** The public key is committed in `release-keys/`.
`jankurai-installer.sh` pins its SHA-256 in a `release_keys` table, and each
entry covers a tag range. The installer downloads the key with the release and
rejects it unless it matches the pin. Rotation closes the old entry's range and
appends a new key, so old releases keep verifying. To revoke, ship an installer
whose table no longer accepts the key for the affected tags, then re-sign or
withdraw those tags. [docs/release.md](docs/release.md#rotating-or-revoking-the-signing-key)
has the procedure.

**Transparency log.** Key signatures are not uploaded to Rekor by default.
Signing is fully offline, and verification uses `--insecure-ignore-tlog=true
--offline=true`. Uploading is an explicit owner opt-in
(`JANKURAI_RELEASE_TLOG_UPLOAD=1`), and the installer accepts either form. We
chose this deliberately. A public log entry adds third-party evidence of when a
signature was made. It does not add trust in who made it, because that trust
rests on the pinned key either way. And it publishes signing metadata the owner
may not want public.

**What verification proves.**

- v1.7.2 and later. The asset is byte-for-byte what the holder of the pinned
  release key signed. Its archive inventory is exact. Its provenance names the
  tag, source commit and tree, family and Cargo lock digests, member commits and
  toolchain. Builds are reproducible from that source at the recorded build
  root, so anyone can rebuild and compare digests. It does not prove which
  machine built the asset, or that a build service did. That claim now rests on
  custody of the key, not on GitHub's OIDC identity.
- v1.7.1 and earlier. Unchanged. The asset was signed by the `release.yml`
  workflow of `neverhuman/jankurai` for that tag. A GitHub attestation binds it
  to the source commit, the tag and a GitHub-hosted runner.

A compromised release key could sign malicious assets that the installer would
accept, until an installer that no longer trusts that key ships. Report a
suspected compromise privately, as above.

## AI-Agent Boundaries

Jankurai stores agent policy in repository files so humans can review it. Trusted policy should not be rewritten by untrusted context, generated outputs, repair plans, or model responses. New agent/tool permissions must be scoped to the requested proof lane and documented in receipts.
