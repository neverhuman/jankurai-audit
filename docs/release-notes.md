Jankurai v1.7.4 keeps the v1.7.3 scoring and adds reviewed dead-language
allowances. It is built on our own build hosts and signed with the Jankurai
release key, as v1.7.2 and v1.7.3 were. GitHub is only where releases are
published.

Changes from v1.7.3:

- HLT-001 dead-language hits can be covered by reviewed `[[dead_language_allow]]`
  records in `agent/audit-policy.toml`. Each record names its terms, the paths
  it covers, an owner, a reason and an expiry date. A covered hit is not a
  finding and does not cap the score. An expired or incomplete record covers
  nothing and the hit counts again. The legacy `[dead_language] allow_terms`
  table is still read.
- Nothing else in scoring changes. On the 100-repository parity set the
  v1.7.4 candidate's findings, scores, caps and decisions equal v1.7.3's.

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
