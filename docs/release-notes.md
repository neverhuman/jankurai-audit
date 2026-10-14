Jankurai v1.7.5 is v1.7.4 with `diff-audit` fixed. It is built on our own build
hosts and signed with the Jankurai release key, as v1.7.2 through v1.7.4 were.
GitHub is only where releases are published.

Changes from v1.7.4:

- `jankurai diff-audit` (the changed-fast audit) again reads the fixed control
  files that every run needs: `README.md`, `docs/release.md`, `contracts`, `db`,
  `schemas`, the rendered-UX roots under `apps/`, and `tools/security-lane.sh`.
  In v1.7.4 an unchanged release doc, README, contract surface or schemas
  directory was invisible to diff-audit. It reported false HLT-025 findings and
  false release-readiness, agent-docs and contract caps on pull requests whose
  full audit was clean. diff-audit verdicts again match v1.6.11's.
- Full-audit scoring does not change. On the 100-repository parity set the
  v1.7.5 candidate's findings, scores, caps and decisions equal v1.7.4's.

Public products are the Jankurai auditor, the Tuiwright CLI, and the UX QA npm CLI
package. Each native tarball holds the binary, its license, the family lock, the
Cargo lock, and build provenance (`jankurai.release/v2`). The provenance names the
tag, source commit and tree, lock digests, member commits, and toolchain. Every
asset has a SHA-256 checksum and a cosign key signature bundle (`.cosign.bundle`).
The release public key is attached, and its SHA-256 is pinned in the installer.

Install with the attached `jankurai-installer.sh`. It bootstraps temporary
verifiers with embedded version and SHA-256 pins, checks the key pin, checksum,
signature, archive inventory, and provenance, and runs the staged binary before
it atomically replaces an installed version. It needs no GitHub login or compiler.
Releases up to v1.7.1 keep verifying under their original GitHub workflow
signatures and attestations.

See CHANGELOG.md for the changes in this release.
