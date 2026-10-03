Jankurai v1.7.2 is the first release built on our own build hosts and signed with
the Jankurai release key. GitHub is now only where releases are published.

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
