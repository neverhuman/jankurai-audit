# Install Jankurai

The current published release is
[v1.7.1](https://github.com/neverhuman/jankurai/releases/tag/v1.7.1).
It provides native Linux x86-64 and Apple Silicon macOS binaries.

```sh
bash -o pipefail -c 'curl --proto "=https" --tlsv1.2 -fsSL https://raw.githubusercontent.com/neverhuman/jankurai/v1.7.1/jankurai-installer.sh | bash -s -- --tag v1.7.1'
export PATH="$HOME/.local/bin:$PATH"
jankurai --version
```

The result is `jankurai 1.7.1`. The default directory is `~/.local/bin`; add the
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
bash -o pipefail -c 'curl --proto "=https" --tlsv1.2 -fsSL https://raw.githubusercontent.com/neverhuman/jankurai/v1.7.1/jankurai-installer.sh | bash -s -- --tag v1.7.1 --product tuiwright'
tuiwright --version
```

Expected: `tuiwright 1.7.1`. Remove it with
`rm ~/.local/bin/tuiwright`.

## UX package

The built `jankurai-ux-qa-1.7.1.tgz` is attached to the release. Browser auditing
requires Node.js 24, npm, Playwright 1.59.1, and Chromium. This optional package's
manual verification uses [GitHub CLI 2.100.0](https://github.com/cli/cli/releases/tag/v2.100.0),
[cosign 3.1.3](https://github.com/sigstore/cosign/releases/tag/v3.1.3), and
[jq 1.8.2](https://github.com/jqlang/jq/releases/tag/jq-1.8.2). Install those tools
using their verified upstream distribution before continuing; no GitHub login is
needed. Auditor and TUI installation above bootstrap their own temporary verifiers.

Run this in Bash, in a new directory for the downloaded package. The Linux
provenance describes the workflow that built the platform-independent npm asset:

```bash
set -euo pipefail
repo=neverhuman/jankurai
tag=v1.7.1
package=jankurai-ux-qa-1.7.1.tgz
provenance=provenance-x86_64-unknown-linux-gnu.json
identity="https://github.com/$repo/.github/workflows/release.yml@refs/tags/$tag"
for file in "$package" "$provenance"; do
  for suffix in '' .sha256 .sigstore.bundle .attestation.jsonl; do
    curl --proto '=https' --tlsv1.2 -fsSL \
      "https://github.com/$repo/releases/download/$tag/$file$suffix" -o "$file$suffix"
  done
  if command -v shasum >/dev/null; then shasum -a 256 -c "$file.sha256"
  else sha256sum -c "$file.sha256"; fi
  cosign verify-blob "$file" --bundle "$file.sigstore.bundle" \
    --certificate-identity "$identity" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
done
commit="$(jq -er '.commit | select(test("^[0-9a-f]{40}$"))' "$provenance")"
for file in "$package" "$provenance"; do
  env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN \
    gh attestation verify "$file" --bundle "$file.attestation.jsonl" --repo "$repo" \
    --cert-identity "$identity" --cert-oidc-issuer https://token.actions.githubusercontent.com \
    --deny-self-hosted-runners \
    --signer-digest "$commit" --source-digest "$commit" --source-ref "refs/tags/$tag"
done
```

Only after every verification command succeeds:

```sh
npm install -g ./jankurai-ux-qa-1.7.1.tgz playwright@1.59.1
npx playwright@1.59.1 install chromium
jankurai-ux-qa --version
jankurai-ux-qa audit --url https://example.com --out ux-report.json
```

Expected: `jankurai-ux-qa 1.7.1`. Remove it with
`npm uninstall -g @jankurai/ux-qa`; remove Playwright separately if unused.

## Verification and source builds

The installer pins GitHub CLI 2.100.0, cosign 3.1.3, and jq 1.8.2 by version and
SHA-256 for each platform. It verifies the asset checksum, Sigstore identity,
archive inventory and file types, repository and lock provenance, and the local
GitHub attestation bundle. Attestation policy binds the source commit, tag,
release workflow, and GitHub-hosted runner. `--verify-only` also executes the
verified staged binary. Maintainers use `--assets-dir dist` to test signed staged
assets before publication; the same verification policy applies.

Contributor builds and family commands are documented in the
[README](../README.md#build-from-a-fresh-clone). Standard and schema versions
remain independent of the public CLI release number.
