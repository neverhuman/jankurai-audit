#!/usr/bin/env bash
# Build one target of a Jankurai release on our own build host.
#
# The release tooling is this checkout; the product source is one registered hub worktree at --tag plus
# immutable exported member inputs at each family.lock pin, built with the tag's
# own `scripts/family.sh build --release`. Output is an unsigned, reproducible
# inventory (tarballs, .sha256, provenance) ready for ops/release/sign-release.sh.
# shellcheck source=ops/release/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<'EOF'
usage: build-release.sh --tag vX.Y.Z [--target triple] [--out dir] [--workdir dir]
                        [--members hosted|mirror|<checkout-root>] [--source-repo path]
                        --expect-commit sha [--builder container|host]

  --target         defaults to this host: x86_64-unknown-linux-gnu or aarch64-apple-darwin.
                   Cross builds are refused; build each target on a host of that platform.
  --out            unsigned assets (default target/release-dist/<tag>). Linux also writes
                   the platform-independent assets; a macOS build host writes only its own.
  --workdir        build output below the release source lane target/ (default target/release-build/<target>).
  --members        where member sources come from (default: the hosted forge, using your
                   Git credentials); every tag is checked against its locked commit.
  --source-repo    repository holding the release tag (default: this checkout).
  --expect-commit  required; refuse unless the tag names this commit.
  --builder        container (the Linux default) compiles inside the digest-pinned Debian 12
                   image of ops/release/builder/Dockerfile, so the binaries need at most
                   glibc 2.36; the image is recorded in the provenance. host compiles with
                   this host's toolchain (the macOS default; on Linux the binaries then need
                   this host's glibc).
EOF
}

tag='' target='' out='' workdir='' members=hosted source_repo="$release_tooling" expect='' builder=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) tag="${2:?}"; shift 2 ;;
    --target) target="${2:?}"; shift 2 ;;
    --out) out="${2:?}"; shift 2 ;;
    --workdir) workdir="${2:?}"; shift 2 ;;
    --members) members="${2:?}"; shift 2 ;;
    --source-repo) source_repo="${2:?}"; shift 2 ;;
    --expect-commit) expect="${2:?}"; shift 2 ;;
    --builder) builder="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done
valid_release_tag "$tag" || fail 'a release tag vX.Y.Z is required'
host="$(host_target)" || fail 'unsupported build host; use Linux x86-64 or Apple Silicon macOS'
target="${target:-$host}"
[[ "$target" == "$host" ]] || fail "cross builds are not supported: build $target on a $target host"
case "${builder:=$([[ "$target" == *-linux-gnu ]] && echo container || echo host)}" in
  container) [[ "$target" == *-linux-gnu ]] || fail 'the container builder builds Linux targets only' ;;
  host) [[ "$target" != *-linux-gnu ]] || note "warning: a host build links against this host's glibc ($(ldd --version 2>/dev/null | head -1)); published Linux releases use --builder container" ;;
  *) fail "unknown builder: $builder (container or host)" ;;
esac
[[ -z "$(git -C "$release_tooling" status --porcelain)" ]] || fail 'release tooling checkout must be clean'
[[ "$expect" =~ ^[a-f0-9]{40}$ ]] || fail '--expect-commit is required'
source "$release_tooling/scripts/node-bootstrap.sh"
# One source lane; members become verified build inputs, not new worktrees.
source_primary="$(git -C "$source_repo" rev-parse --path-format=absolute --git-common-dir)"
# Native builds cannot remount their source. Require a public, reproducible
# primary location before allocating a lane; Linux containers use neutral mounts.
if [[ "$builder" == host ]]; then
  [[ "$(realpath "$(dirname "$source_primary")")" == /jankurai/repository ]] ||
    fail 'native release builds require the existing primary repository at /jankurai/repository; private build paths must not enter release assets'
fi
src="$(node "$release_tooling/ops/release/prepare-source.mjs" "$source_repo" "$tag" "$expect" "release-$tag-$target")"
source "$src/scripts/node-bootstrap.sh"
out="$(mkdir -p "${out:-$src/target/release-dist/$tag}" && cd "${out:-$src/target/release-dist/$tag}" && pwd)"
workdir="${workdir:-$src/target/release-build/$target}"
mkdir -p "$workdir"
workdir="$(cd "$workdir" && pwd -P)"
case "$workdir/" in "$src/target/"*) ;; *) fail 'workdir must be below the owned release source target/' ;; esac
[[ -z "$(ls -A "$workdir")" ]] || fail "workdir is not empty; preserve its evidence: $workdir"
for tool in git node npm cargo rustc rustup tar; do command -v "$tool" >/dev/null || fail "missing build tool: $tool"; done
[[ "$builder" != container ]] || command -v docker >/dev/null || fail 'missing build tool: docker (needed by --builder container)'

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

commit="$(git -C "$src" rev-parse HEAD)"
[[ "$commit" == "$expect" ]] || fail 'source worktree differs from expected release commit'
tree="$(git -C "$src" rev-parse "$commit^{tree}")"
[[ "$(cat "$src/VERSION")" == "${tag#v}" ]] || fail "VERSION at $tag is not ${tag#v}"
channel="$(sed -n 's/^channel *= *"\(.*\)"/\1/p' "$src/rust-toolchain.toml")"
[[ -n "$channel" ]] || fail 'rust-toolchain.toml has no channel'
(cd "$src" && rustup toolchain install --profile minimal "$channel" >/dev/null 2>&1) || true
rustc_version="$(cd "$src" && rustc --version)"
[[ "$rustc_version" == "rustc $channel "* ]] || fail "toolchain $channel is not active in the source tree: $rustc_version"

note "Composing members at their family.lock pins ($members)"
source "$release_tooling/scripts/node-bootstrap.sh"
node "$release_tooling/ops/release/compose-source.mjs" materialize "$src" "$members"

# Reproducibility: the tag's commit time, and build paths mapped to fixed names.
export SOURCE_DATE_EPOCH
SOURCE_DATE_EPOCH="$(git -C "$src" show -s --format=%ct "$commit")"
export CARGO_INCREMENTAL=0 CARGO_NET_GIT_FETCH_WITH_CLI=true TZ=UTC LC_ALL=C
export CARGO_PROFILE_DEV_DEBUG="${CARGO_PROFILE_DEV_DEBUG:-line-tables-only}"
unset CARGO_TARGET_DIR CARGO_BUILD_TARGET_DIR CARGO_BUILD_RUSTFLAGS CARGO_ENCODED_RUSTFLAGS

if [[ "$builder" == container ]]; then
  dockerfile="$release_tooling/ops/release/builder/Dockerfile"
  dockerfile_sha256="$(sha256 "$dockerfile")"
  base_image="$(sed -n 's/^FROM \(.*@sha256:[0-9a-f]\{64\}\)$/\1/p' "$dockerfile")"
  [[ -n "$base_image" ]] || fail 'ops/release/builder/Dockerfile must pin its base image by digest'
  image="jankurai-release-builder:${dockerfile_sha256:0:16}"
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    note "Building the release builder image $image"
    docker build --quiet --tag "$image" --file "$dockerfile" "$(dirname "$dockerfile")" >/dev/null
  fi
  image_id="$(docker image inspect --format '{{.Id}}' "$image")"
  # A private Cargo home under the workdir: Git and crates.io sources are fetched
  # here on the host, where the member credentials live, and the container
  # compiles offline. Stable container paths also normalize env!(CARGO_MANIFEST_DIR),
  # which rustc's --remap-path-prefix does not rewrite.
  cargo_home="$workdir/cargo-home"
  container_src=/jankurai/source
  container_tooling=/jankurai/tooling
  container_workdir="$container_src/${workdir#"$src/"}"
  container_cargo_home="$container_workdir/cargo-home"
  mkdir -p "$cargo_home" "$workdir/home" "$workdir/etc"
  # The build user needs an account entry (Node's os.userInfo); name only it.
  printf 'root:x:0:0::/root:/bin/sh\nbuilder:x:%s:%s::%s:/bin/sh\n' "$(id -u)" "$(id -g)" "$container_workdir/home" > "$workdir/etc/passwd"
  printf 'root:x:0:\nbuilder:x:%s:\n' "$(id -g)" > "$workdir/etc/group"
  in_builder() {
    docker run --rm --network host --user "$(id -u):$(id -g)" \
      --volume "$src:$container_src" --volume "$release_tooling:$container_tooling:ro" \
      --volume "$source_primary:$source_primary:ro" --workdir "$container_src" \
      --volume "$workdir/etc/passwd:/etc/passwd:ro" --volume "$workdir/etc/group:/etc/group:ro" \
      --env HOME="$container_workdir/home" --env CARGO_HOME="$container_cargo_home" --env CARGO_NET_OFFLINE=true \
      --env SOURCE_DATE_EPOCH --env CARGO_INCREMENTAL --env CARGO_PROFILE_DEV_DEBUG --env CARGO_NET_GIT_FETCH_WITH_CLI \
      --env TZ --env LC_ALL --env RUSTFLAGS="${RUSTFLAGS:-}" "$image" "$@"
  }
  sysroot="$(in_builder rustc --print sysroot)"
  rustc_version="$(in_builder rustc --version)"
  [[ "$rustc_version" == "rustc $channel "* ]] || fail "builder toolchain is not $channel: $rustc_version"
  export RUSTFLAGS="--remap-path-prefix=$container_src=/jankurai --remap-path-prefix=$container_cargo_home=/cargo --remap-path-prefix=$sysroot=/rust"
  note "Fetching Cargo sources on the host into $cargo_home"
  node "$release_tooling/ops/release/compose-source.mjs" fuse "$src"
  (cd "$src/.fusion" && CARGO_HOME="$cargo_home" cargo fetch --locked)
  note "Building $tag for $target in $image ($rustc_version)"
  in_builder node "$container_tooling/ops/release/compose-source.mjs" build "$container_src" "$target"
  in_builder node --test scripts/family-operation-review.test.mjs scripts/family-recovery.test.mjs
  record="$workdir/builder.json"
  in_builder node -e '
    const { execFileSync } = require("node:child_process");
    const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
    const [image, imageId, base, dockerfileSha] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      kind: "container", build_root: "/jankurai", source_root: "/jankurai/source",
      image, image_id: imageId, base_image: base, dockerfile_sha256: dockerfileSha,
      glibc: run("ldd", ["--version"]).split("\n")[0],
      toolchain: { rustc: run("rustc", ["-vV"]), cargo: run("cargo", ["--version"]),
        node: process.version, npm: run("npm", ["--version"]) },
    }, null, 2) + "\n");' "$image" "$image_id" "$base_image" "$dockerfile_sha256" > "$record"
  export JANKURAI_RELEASE_BUILDER_RECORD="$record"
  binary="$src/.fusion/target/$target/release/jankurai"
  glibc_needed="$(objdump -T "$binary" 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1 || true)"
  note "jankurai needs ${glibc_needed:-an unknown glibc} (builder: $(sed -n 's/.*"glibc": "\(.*\)",*/\1/p' "$record"))"
else
  cargo_home="${CARGO_HOME:-$HOME/.cargo}"
  sysroot="$(cd "$src" && rustc --print sysroot)"
  export RUSTFLAGS="--remap-path-prefix=$src=/jankurai --remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$sysroot=/rust"
  note "Building $tag for $target ($rustc_version)"
  node "$release_tooling/ops/release/compose-source.mjs" build "$src" "$target"
  # The native exchange and recovery primitives are platform-specific; exercise them here.
  (cd "$src" && node --test scripts/family-operation-review.test.mjs scripts/family-recovery.test.mjs)
fi
node "$release_tooling/ops/release/compose-source.mjs" verify "$src" "$commit"

note "Packaging into $out"
record="$(node "$release_tooling/ops/release/package-release.mjs" --source "$src" --target "$target" \
  --out "$out" --tooling "$release_tooling" --tag "$tag")"
printf '%s\n' "$record" > "$workdir/build-record.json"
printf '%s\n' "$record"
printf 'Built %s %s (commit %s, tree %s) into %s; sign with ops/release/sign-release.sh\n' \
  "$tag" "$target" "$commit" "$tree" "$out"

printf 'Retained locked release source lane %s and all target evidence. After publication, follow docs/release.md custody cleanup.\n' "$src" >&2
