# Security Policy

## Supported Versions

Security fixes target `main` and the latest published release, currently
[v1.7.0](https://github.com/neverhuman/jankurai/releases/tag/v1.7.0). Older
snapshots are supported only when maintainers explicitly mark them in release notes.

## Private Reporting

Do not open a public issue for suspected vulnerabilities.

Use GitHub private vulnerability reporting:

https://github.com/neverhuman/jankurai/security/advisories/new

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

## AI-Agent Boundaries

Jankurai stores agent policy in repository files so humans can review it. Trusted policy should not be rewritten by untrusted context, generated outputs, repair plans, or model responses. New agent/tool permissions must be scoped to the requested proof lane and documented in receipts.
