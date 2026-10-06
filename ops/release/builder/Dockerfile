# Linux release builder. Debian 12 (bookworm, glibc 2.36), so the released
# x86_64-unknown-linux-gnu binaries need at most GLIBC_2.36 and run on bookworm
# and every newer glibc distribution. Every input is pinned: the base image by
# digest (Rust 1.97.1, the channel rust-toolchain.toml names) and Node.js by the
# SHA-256 nodejs.org publishes. ops/release/build-release.sh builds this image,
# runs the compile in it, and records the base digest, this file's SHA-256 and
# the image ID in the release provenance.
FROM docker.io/library/rust:1.97.1-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97

ARG NODE_VERSION=24.21.0
ARG NODE_SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6

# rust-toolchain.toml asks for rustfmt and clippy; install them now so the build
# never writes to the toolchain or reaches the network for it.
RUN rustup component add rustfmt clippy \
 && curl --proto '=https' --tlsv1.2 -fsSL --retry 3 \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
 && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
 && rm /tmp/node.tar.xz \
 && chmod -R a+rX /usr/local/rustup /usr/local/cargo \
 && node --version && npm --version && rustc --version && cargo fmt --version && cargo clippy --version
