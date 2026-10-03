#!/usr/bin/env bash
# Build one target of a Jankurai release on our own build host.
#
# The release tooling is this checkout; the product source is a fresh clone of
# the hub at --tag plus every member at its family.lock pin, built with the tag's
# own `scripts/family.sh build --release`. Output is an unsigned, reproducible
# inventory (tarballs, .sha256, provenance) ready for ops/release/sign-release.sh.
# shellcheck source=ops/release/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
usage: build-release.sh --tag vX.Y.Z [--target triple] [--out dir] [--workdir dir]
                        [--members hosted|mirror|<checkout-root>] [--source-repo path]
                        [--expect-commit sha]

  --target         defaults to this host: x86_64-unknown-linux-gnu or aarch64-apple-darwin.
                   Cross builds are refused; build each target on a host of that platform.
  --out            unsigned assets (default target/release-dist/<tag>). Linux also writes
                   the platform-independent assets; a macOS build host writes only its own.
  --workdir        fresh build tree (default target/release-build/<tag>-<target>).
  --members        where member sources come from (default: the hosted forge, using your
                   Git credentials); every tag is checked against its locked commit.
  --source-repo    repository holding the release tag (default: this checkout).
  --expect-commit  refuse unless the tag names this commit.
EOF
}

tag='' target='' out='' workdir='' members=hosted source_repo="$release_tooling" expect=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) tag="${2:?}"; shift 2 ;;
    --target) target="${2:?}"; shift 2 ;;
    --out) out="${2:?}"; shift 2 ;;
    --workdir) workdir="${2:?}"; shift 2 ;;
    --members) members="${2:?}"; shift 2 ;;
    --source-repo) source_repo="${2:?}"; shift 2 ;;
    --expect-commit) expect="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done
valid_release_tag "$tag" || fail 'a release tag vX.Y.Z is required'
host="$(host_target)" || fail 'unsupported build host; use Linux x86-64 or Apple Silicon macOS'
target="${target:-$host}"
[[ "$target" == "$host" ]] || fail "cross builds are not supported: build $target on a $target host"
out="$(mkdir -p "${out:-$release_tooling/target/release-dist/$tag}" && cd "${out:-$release_tooling/target/release-dist/$tag}" && pwd)"
workdir="${workdir:-$release_tooling/target/release-build/$tag-$target}"
if [[ -e "$workdir" ]] && [[ -n "$(ls -A "$workdir")" ]]; then
  fail "workdir is not empty; release builds start fresh: $workdir"
fi
mkdir -p "$workdir/src"
workdir="$(cd "$workdir" && pwd)"
src="$workdir/src/jankurai"
case "$workdir/" in
  "$HOME"/*) note "warning: the jankurai binary embeds its build root ($workdir/src); for a published build use a neutral --workdir such as /srv/jankurai-release/$tag-$target" ;;
esac
for tool in git node npm cargo rustc rustup tar; do command -v "$tool" >/dev/null || fail "missing build tool: $tool"; done

# Ambient Cargo configuration above the build tree would change the build.
dir="$workdir"
while [[ "$dir" != / ]]; do
  for config in "$dir/.cargo/config" "$dir/.cargo/config.toml"; do
    if [[ -e "$config" && "$dir" != "${CARGO_HOME:-$HOME/.cargo}" && "$dir/.cargo" != "${CARGO_HOME:-$HOME/.cargo}" ]]; then
      fail "ambient Cargo configuration would affect the release build: $config"
    fi
  done
  dir="$(dirname "$dir")"
done

note "Cloning the hub at $tag"
git clone --quiet --no-checkout --no-hardlinks "$source_repo" "$src"
commit="$(git -C "$src" rev-parse --verify --quiet "refs/tags/$tag^{commit}")" || fail "tag $tag is not in $source_repo"
[[ -z "$expect" || "$commit" == "$expect" ]] || fail "tag $tag names $commit, expected $expect"
git -C "$src" checkout --quiet --detach "$commit"
tree="$(git -C "$src" rev-parse "$commit^{tree}")"
[[ "$(cat "$src/VERSION")" == "${tag#v}" ]] || fail "VERSION at $tag is not ${tag#v}"
channel="$(sed -n 's/^channel *= *"\(.*\)"/\1/p' "$src/rust-toolchain.toml")"
[[ -n "$channel" ]] || fail 'rust-toolchain.toml has no channel'
(cd "$src" && rustup toolchain install --profile minimal "$channel" >/dev/null 2>&1) || true
rustc_version="$(cd "$src" && rustc --version)"
[[ "$rustc_version" == "rustc $channel "* ]] || fail "toolchain $channel is not active in the source tree: $rustc_version"

note "Composing members at their family.lock pins ($members)"
source "$release_tooling/scripts/node-bootstrap.sh"
node "$release_tooling/ops/release/compose-source.mjs" clone "$src" "$members"

# Reproducibility: the tag's commit time, and build paths mapped to fixed names.
export SOURCE_DATE_EPOCH
SOURCE_DATE_EPOCH="$(git -C "$src" show -s --format=%ct "$commit")"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
sysroot="$(cd "$src" && rustc --print sysroot)"
export RUSTFLAGS="--remap-path-prefix=$workdir/src=/jankurai --remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$sysroot=/rust"
export CARGO_INCREMENTAL=0 CARGO_NET_GIT_FETCH_WITH_CLI=true TZ=UTC LC_ALL=C
unset CARGO_TARGET_DIR CARGO_BUILD_TARGET_DIR CARGO_BUILD_RUSTFLAGS CARGO_ENCODED_RUSTFLAGS

note "Building $tag for $target ($rustc_version)"
(cd "$src" && bash scripts/family.sh build --release --target "$target")
# The native exchange and recovery primitives are platform-specific; exercise them here.
(cd "$src" && node --test scripts/family-operation-review.test.mjs scripts/family-recovery.test.mjs)
node "$release_tooling/ops/release/compose-source.mjs" verify "$src" "$commit"

note "Packaging into $out"
record="$(node "$release_tooling/ops/release/package-release.mjs" --source "$src" --target "$target" \
  --out "$out" --tooling "$release_tooling" --tag "$tag")"
printf '%s\n' "$record" > "$workdir/build-record.json"
printf '%s\n' "$record"
printf 'Built %s %s (commit %s, tree %s) into %s; sign with ops/release/sign-release.sh\n' \
  "$tag" "$target" "$commit" "$tree" "$out"
