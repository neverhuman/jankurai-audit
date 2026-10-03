# Install Jankurai

The current published release is
[v1.7.2](https://github.com/neverhuman/jankurai-audit/releases/tag/v1.7.2).
It provides native Linux x86-64 binaries, and Apple Silicon macOS binaries when
the release lists them (they are built on a separate macOS build host).

```sh
bash -o pipefail -c 'curl --proto "=https" --tlsv1.2 -fsSL https://github.com/neverhuman/jankurai-audit/releases/download/v1.7.2/jankurai-installer.sh | bash -s -- --tag v1.7.2'
export PATH="$HOME/.local/bin:$PATH"
jankurai --version
```

The result is `jankurai 1.7.2`. The default directory is `~/.local/bin`; add the
PATH line to `~/.bashrc` or `~/.zshrc` if needed. Pass `--install-dir /your/bin`
to select a different writable directory. No sudo, Rust, Node.js, GitHub login,
or preinstalled verifier is needed for the auditor or Tuiwright. The platform
must provide Bash, curl, tar, a SHA-256 tool, gzip on Linux, and unzip on macOS.

Native Windows (PowerShell or Git Bash), Intel macOS, Linux ARM64, and Alpine/musl
are unsupported. Source builds require a supported Unix platform too. Do not use
the historical monolithic `cargo install --path crates/jankurai` instructions.
The installer is also attached to the release for download and inspection.

Run the command again to upgrade or reinstall. It checks the staged binary and
replaces the installed file atomically. A download, verification, or version
failure preserves the existing binary. Remove it with `rm ~/.local/bin/jankurai`;
the installer keeps no permanent verification tools or background services.
Repository audit reports remain yours to retain or remove separately.

## Audit modes

Run this from the repository you want to inspect:

```sh
jankurai audit .
```

Add `--json`, `--md`, and `--repair-queue-jsonl` when you want those files
written explicitly. Advisory mode emits findings for review. Ratchet mode additionally takes
`--baseline path/to/accepted-score.json` and rejects regressions. Release mode
also takes a baseline and applies release policy. Use `jankurai audit --help`
for the available policy and output options.

For a pre-commit or pre-PR pass over the files you touched:

```sh
jankurai diff-audit --base-ref origin/main
```

`diff-audit` is the local speed path. The GitHub Action stays a full-repository
audit. A diff report is not the evidence behind the README badge. The auditor
checks static policy and structure. It does not run an application pentest, and
it does not review cloud IAM, Terraform or Kubernetes posture, or runtime
authorization.

## Tuiwright

```sh
bash -o pipefail -c 'curl --proto "=https" --tlsv1.2 -fsSL https://github.com/neverhuman/jankurai-audit/releases/download/v1.7.2/jankurai-installer.sh | bash -s -- --tag v1.7.2 --product tuiwright'
tuiwright --version
```

Expected: `tuiwright 1.7.2`. Remove it with
`rm ~/.local/bin/tuiwright`.

## UX package

The built `jankurai-ux-qa-1.7.2.tgz` is attached to the release. Browser auditing
requires Node.js 24, npm, Playwright 1.59.1, and Chromium. This optional package's
manual verification uses [cosign 3.1.3](https://github.com/sigstore/cosign/releases/tag/v3.1.3)
and [jq 1.8.2](https://github.com/jqlang/jq/releases/tag/jq-1.8.2). Install them
using their verified upstream distribution before continuing; no GitHub login is
needed. Auditor and TUI installation above bootstrap their own temporary verifiers.

Run this in Bash, in a new directory for the downloaded package. The release
public key must match the SHA-256 pinned in `jankurai-installer.sh`'s
`release_keys` table; the Linux provenance describes the build that produced the
platform-independent npm asset:

```bash
set -euo pipefail
base=https://github.com/neverhuman/jankurai-audit/releases/download/v1.7.2
package=jankurai-ux-qa-1.7.2.tgz
provenance=provenance-x86_64-unknown-linux-gnu.json
key=jankurai-release-2026.pub
curl --proto '=https' --tlsv1.2 -fsSL "$base/jankurai-installer.sh" -o installer.sh
curl --proto '=https' --tlsv1.2 -fsSL "$base/$key" -o "$key"
pin="$(sed -n "s/^$key|\([0-9a-f]\{64\}\)|.*/\1/p" installer.sh)"
sha() { if command -v shasum >/dev/null; then shasum -a 256 "$1"; else sha256sum "$1"; fi | cut -d ' ' -f 1; }
[[ "$(sha "$key")" == "$pin" ]]
for file in "$package" "$provenance"; do
  for suffix in '' .sha256 .cosign.bundle; do
    curl --proto '=https' --tlsv1.2 -fsSL "$base/$file$suffix" -o "$file$suffix"
  done
  [[ "$(cat "$file.sha256")" == "$(sha "$file")  $file" ]]
  cosign verify-blob "$file" --bundle "$file.cosign.bundle" --key "$key" \
    --insecure-ignore-tlog=true --offline=true
done
jq -e '.schema == "jankurai.release/v2" and .tag == "v1.7.2"' "$provenance"
```

Compare the pin with the installer in the hub repository on `main` as well as the
downloaded copy. Releases up to v1.7.1 were signed keylessly by the GitHub
workflow of `neverhuman/jankurai` and verify with `.sigstore.bundle` and
`.attestation.jsonl` against that workflow identity, as their own release
documentation describes; the installer handles both by itself.

Only after every verification command succeeds:

```sh
npm install -g ./jankurai-ux-qa-1.7.2.tgz playwright@1.59.1
npx playwright@1.59.1 install chromium
jankurai-ux-qa --version
jankurai-ux-qa audit --url https://example.com --out ux-report.json
```

Expected: `jankurai-ux-qa 1.7.2`. Remove it with
`npm uninstall -g @jankurai/ux-qa`; remove Playwright separately if unused.

## Verification and source builds

The installer pins cosign 3.1.3 and jq 1.8.2 (and, for keyless releases, GitHub
CLI 2.100.0) by version and SHA-256 for each platform. For v1.7.2 and later it
verifies the downloaded release public key against its pinned SHA-256, the asset
checksum, the key signature, archive inventory and file types, and the tag,
commit, tree and lock provenance. For v1.7.1 and earlier it verifies the checksum,
the Sigstore workflow identity, and the GitHub attestation bundle bound to the
source commit, tag, release workflow and GitHub-hosted runner. `--verify-only`
also executes the verified staged binary. Maintainers use `--assets-dir dist` to test signed staged
assets before publication; the same verification policy applies.

Contributor builds and family commands are documented in the
[README](../README.md#build-from-a-fresh-clone). Standard and schema versions
remain independent of the public CLI release number.
