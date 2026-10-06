Jankurai v1.7.3 brings the public auditor in line with the provider-aware CI
crediting of the governed build. It is built on our own build hosts and signed
with the Jankurai release key, as v1.7.2 was. GitHub is only where releases are
published.

Scoring changes from v1.7.2:

- A repository gated by the jeryu forge earns proof CI presence, the speed CI
  cache hint and the security workflow-lint check from the resolved lane its
  `.jeryu/ci.toml` declares, as a GitHub workflow does. The declaration alone
  still earns nothing. Workflow linting is not applicable without workflow files.
- `npm test`, `npm run <script>`, `pnpm run <script>` and `yarn <script>` lanes
  resolve through package.json scripts.
- A declared lane that resolves to no repository content is reported as a soft
  finding at `.jeryu/ci.toml`.
- HLT-031 no longer reads prose `as` in comments, string literals or import
  aliases as a TypeScript boundary cast.

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
