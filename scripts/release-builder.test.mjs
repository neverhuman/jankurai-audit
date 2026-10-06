import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const hub = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dockerfile = fs.readFileSync(path.join(hub, 'ops/release/builder/Dockerfile'), 'utf8');
const build = fs.readFileSync(path.join(hub, 'ops/release/build-release.sh'), 'utf8');
const channel = /^channel = "([^"]+)"/m.exec(fs.readFileSync(path.join(hub, 'rust-toolchain.toml'), 'utf8'))[1];

test('the Linux release builder is Debian 12 pinned by digest at the hub toolchain', () => {
  const from = dockerfile.split('\n').filter(line => line.startsWith('FROM '));
  assert.equal(from.length, 1);
  assert.match(from[0], new RegExp(`^FROM docker\\.io/library/rust:${channel.replace(/\./g, '\\.')}-bookworm@sha256:[0-9a-f]{64}$`));
});

test('the builder verifies Node.js against a pinned SHA-256 and installs the toolchain components', () => {
  assert.match(dockerfile, /^ARG NODE_SHA256=[0-9a-f]{64}$/m);
  assert.match(dockerfile, /sha256sum -c -/);
  assert.match(dockerfile, /rustup component add rustfmt clippy/);
});

test('Linux releases build in the container by default and record it in provenance', () => {
  assert.match(build, /builder:=\$\(\[\[ "\$target" == \*-linux-gnu \]\] && echo container \|\| echo host\)/);
  assert.match(build, /CARGO_NET_OFFLINE=true/);
  assert.match(build, /JANKURAI_RELEASE_BUILDER_RECORD/);
  const packager = fs.readFileSync(path.join(hub, 'ops/release/package-release.mjs'), 'utf8');
  for (const field of ['image_id', 'base_image', 'dockerfile_sha256', 'glibc']) assert.ok(packager.includes(field), field);
});
