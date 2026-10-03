// End to end: throwaway key pair -> install the public key -> sign a fake
// inventory with the real pinned cosign -> verify offline -> install through the
// installer's own verification path. Plus the fail-closed cases around the key.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { reproducibleTarball, writeChecksums } from '../ops/release/package-release.mjs';
import { parseKeyTable, selectKey, keySigned } from '../ops/release/release-keys.mjs';

const hub = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const PINNED = { 'linux-x64': ['cosign-linux-amd64', '4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71'],
  'darwin-arm64': ['cosign-darwin-arm64', '5cf948c2f4dfe59687bdd0b8523709067383e03982cc543475c8a7dc70e92a76'] };

// The real upstream cosign 3.1.3, checked against the same pin the installer uses.
function pinnedCosign() {
  const pin = PINNED[`${process.platform}-${process.arch}`];
  if (!pin) return null;
  const cached = path.join(hub, 'target/test-tools', pin[0]);
  for (const candidate of [process.env.JANKURAI_TEST_COSIGN, cached]) {
    if (candidate && fs.existsSync(candidate) && sha256(fs.readFileSync(candidate)) === pin[1]) return candidate;
  }
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  const fetched = spawnSync('curl', ['--proto', '=https', '--tlsv1.2', '-fsSL', '--max-time', '120', '-o', `${cached}.part`,
    `https://github.com/sigstore/cosign/releases/download/v3.1.3/${pin[0]}`]);
  if (fetched.status !== 0 || sha256(fs.readFileSync(`${cached}.part`)) !== pin[1]) { fs.rmSync(`${cached}.part`, { force: true }); return null; }
  fs.renameSync(`${cached}.part`, cached);
  fs.chmodSync(cached, 0o755);
  return cached;
}
const cosign = pinnedCosign();
const needsCosign = cosign ? false : 'pinned cosign 3.1.3 is unavailable on this host';
const run = (args, env, options = {}) => spawnSync(args[0], args.slice(1), { env, encoding: 'utf8', ...options });

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-signing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tooling = path.join(root, 'tooling'), keys = path.join(root, 'keys'), dist = path.join(root, 'dist');
  for (const entry of ['ops/release', 'release-keys', 'jankurai-installer.sh']) fs.cpSync(path.join(hub, entry), path.join(tooling, entry), { recursive: true });
  fs.mkdirSync(keys, { mode: 0o700 });
  const env = { ...process.env, COSIGN: cosign };
  delete env.COSIGN_PASSWORD;
  const generate = prefix => {
    const result = run([cosign, 'generate-key-pair', '--output-key-prefix', prefix], { ...env, COSIGN_PASSWORD: 'throwaway' }, { cwd: keys });
    assert.equal(result.status, 0, result.stderr);
    fs.chmodSync(path.join(keys, `${prefix}.key`), 0o600);
  };
  generate('jankurai-release-2026');
  generate('other');
  fs.writeFileSync(path.join(keys, 'password'), 'throwaway\n', { mode: 0o600 });
  const installed = run(['bash', path.join(tooling, 'ops/release/install-public-key.sh'), path.join(keys, 'jankurai-release-2026.pub')], env);
  assert.equal(installed.status, 0, installed.stderr);

  // A fake but well-formed Linux inventory.
  fs.mkdirSync(dist);
  const version = '1.7.2', target = 'x86_64-unknown-linux-gnu', locks = { 'family.lock': 'family fixture\n', 'Cargo.lock': 'cargo fixture\n' };
  const provenance = { schema: 'jankurai.release/v2', version, tag: `v${version}`, target, repository: 'https://github.com/neverhuman/jankurai-audit',
    commit: 'a'.repeat(40), tree: 'b'.repeat(40), family_lock_sha256: sha256(locks['family.lock']), cargo_lock_sha256: sha256(locks['Cargo.lock']) };
  fs.writeFileSync(path.join(dist, `provenance-${target}.json`), JSON.stringify(provenance, null, 2) + '\n');
  const stageRoot = path.join(root, 'stage');
  for (const product of ['jankurai', 'tuiwright']) {
    const name = `${product}-${version}-${target}`, stage = path.join(stageRoot, name);
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, product), `#!/bin/sh\nprintf '${product} ${version}\\n'\n`, { mode: 0o755 });
    for (const [file, bytes] of Object.entries({ ...locks, LICENSE: 'MIT\n' })) fs.writeFileSync(path.join(stage, file), bytes);
    fs.copyFileSync(path.join(dist, `provenance-${target}.json`), path.join(stage, 'provenance.json'));
    reproducibleTarball(stageRoot, name, path.join(dist, `${name}.tar.gz`), 1790969839);
  }
  for (const [file, bytes] of Object.entries(locks)) fs.writeFileSync(path.join(dist, file), bytes);
  fs.writeFileSync(path.join(dist, `jankurai-ux-qa-${version}.tgz`), 'ux fixture');
  fs.copyFileSync(path.join(tooling, 'jankurai-installer.sh'), path.join(dist, 'jankurai-installer.sh'));
  writeChecksums(dist);

  const signEnv = { ...env, JANKURAI_RELEASE_SIGNING_KEY: path.join(keys, 'jankurai-release-2026.key'),
    JANKURAI_RELEASE_SIGNING_PASSWORD_FILE: path.join(keys, 'password') };
  const sign = (extra = {}) => run(['bash', path.join(tooling, 'ops/release/sign-release.sh'), '--dist', dist, '--tag', 'v1.7.2'], { ...signEnv, ...extra });
  const verify = () => run(['bash', path.join(tooling, 'ops/release/verify-release.sh'), '--dist', dist, '--tag', 'v1.7.2'], env);

  // The installer downloads only its pinned verifiers; serve the real cosign and the
  // host jq (whose pin the disposable test copy replaces, as installer.test.mjs does).
  const serve = path.join(root, 'serve'), tools = path.join(root, 'tools');
  fs.mkdirSync(serve); fs.mkdirSync(tools);
  fs.copyFileSync(cosign, path.join(serve, PINNED[`${process.platform}-${process.arch}`][0]));
  const jqAsset = process.platform === 'linux' ? 'jq-linux-amd64' : 'jq-macos-arm64';
  fs.copyFileSync(run(['sh', '-c', 'command -v jq']).stdout.trim(), path.join(serve, jqAsset));
  fs.writeFileSync(path.join(tools, 'curl'), `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),a=process.argv,url=a.find(x=>x.startsWith('https:'));
fs.copyFileSync(path.join(${JSON.stringify(serve)},url.split('/').at(-1)),a[a.indexOf('-o')+1]);`, { mode: 0o755 });
  const install = (tag = 'v1.7.2', product = 'jankurai') => {
    const jqPin = /jq_asset=jq-(?:linux-amd64|macos-arm64)\n\s*jq_hash=([0-9a-f]{64})/;
    let source = fs.readFileSync(path.join(dist, 'jankurai-installer.sh'), 'utf8');
    for (const match of source.matchAll(new RegExp(jqPin, 'g'))) source = source.replace(match[1], sha256(fs.readFileSync(path.join(serve, jqAsset))));
    fs.writeFileSync(path.join(root, 'installer.sh'), source);
    return run(['bash', path.join(root, 'installer.sh'), '--tag', tag, '--product', product, '--assets-dir', dist, '--verify-only'],
      { ...env, PATH: tools + path.delimiter + process.env.PATH });
  };
  return { root, tooling, keys, dist, env, sign, verify, install, signEnv };
}

test('key table: tags after v1.7.1 are key-signed and select exactly one key', () => {
  assert.equal(keySigned('v1.7.1'), false);
  assert.equal(keySigned('v1.7.2'), true);
  const installer = fs.readFileSync(path.join(hub, 'jankurai-installer.sh'), 'utf8');
  assert.deepEqual(parseKeyTable(installer).map(key => [key.name, key.first, key.last]), [['jankurai-release-2026.pub', 'v1.7.2', null]]);
  assert.throws(() => selectKey(installer, 'v1.7.1'), /keyless/);
  const placeholder = installer.replace(/^(jankurai-release-2026\.pub\|)[0-9a-f]{64}/m, `$1${'0'.repeat(64)}`);
  assert.equal(selectKey(placeholder, 'v1.7.2').provisioned, false);
});

test('a throwaway-key release signs, verifies offline and installs through the installer', { skip: needsCosign }, t => {
  const w = workspace(t);
  const signed = w.sign(); assert.equal(signed.status, 0, signed.stderr + signed.stdout);
  assert.ok(fs.existsSync(path.join(w.dist, 'jankurai-release-2026.pub')));
  const bundle = JSON.parse(fs.readFileSync(path.join(w.dist, 'family.lock.cosign.bundle'), 'utf8'));
  assert.equal(bundle.verificationMaterial.tlogEntries, undefined, 'no transparency-log upload by default');
  assert.equal(w.verify().status, 0);
  for (const product of ['jankurai', 'tuiwright']) {
    const result = w.install('v1.7.2', product); assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verified and ran/);
  }
});

test('a tampered asset is rejected even with a recomputed checksum', { skip: needsCosign }, t => {
  const w = workspace(t); assert.equal(w.sign().status, 0);
  const asset = path.join(w.dist, 'jankurai-1.7.2-x86_64-unknown-linux-gnu.tar.gz');
  fs.appendFileSync(asset, 'tampered');
  assert.match(w.install().stderr, /checksum mismatch/);
  fs.writeFileSync(`${asset}.sha256`, `${sha256(fs.readFileSync(asset))}  ${path.basename(asset)}\n`);
  const result = w.install(); assert.notEqual(result.status, 0); assert.match(result.stderr, /release signature verification failed/);
  assert.notEqual(w.verify().status, 0);
});

test('a signature from another key is rejected; signing with it is refused', { skip: needsCosign }, t => {
  const w = workspace(t);
  const refused = w.sign({ JANKURAI_RELEASE_SIGNING_KEY: path.join(w.keys, 'other.key') });
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /not jankurai-release-2026\.pub/);
  assert.equal(w.sign().status, 0);
  const asset = path.join(w.dist, 'jankurai-1.7.2-x86_64-unknown-linux-gnu.tar.gz');
  const forged = run([cosign, 'sign-blob', '--yes', '--key', path.join(w.keys, 'other.key'), '--use-signing-config=false', '--tlog-upload=false',
    '--bundle', `${asset}.cosign.bundle`, asset], { ...w.env, COSIGN_PASSWORD: 'throwaway' });
  assert.equal(forged.status, 0, forged.stderr);
  assert.match(w.install().stderr, /release signature verification failed/);
  // Swapping in the other public key is caught by the installer's pin.
  fs.copyFileSync(path.join(w.keys, 'other.pub'), path.join(w.dist, 'jankurai-release-2026.pub'));
  assert.match(w.install().stderr, /does not match its pin/);
});

test('a missing signature is rejected by the inventory check and the installer', { skip: needsCosign }, t => {
  const w = workspace(t); assert.equal(w.sign().status, 0);
  fs.unlinkSync(path.join(w.dist, 'jankurai-1.7.2-x86_64-unknown-linux-gnu.tar.gz.cosign.bundle'));
  assert.match(w.verify().stderr, /missing: jankurai-1\.7\.2-x86_64-unknown-linux-gnu\.tar\.gz\.cosign\.bundle/);
  assert.notEqual(w.install().status, 0);
});

test('signing fails closed on an exposed, linked or misplaced private key and password file', { skip: needsCosign }, t => {
  const w = workspace(t), key = path.join(w.keys, 'jankurai-release-2026.key');
  fs.chmodSync(key, 0o640);
  assert.match(w.sign().stderr, /readable or writable by group\/others/);
  fs.chmodSync(key, 0o600);
  fs.symlinkSync(key, path.join(w.keys, 'linked.key'));
  assert.match(w.sign({ JANKURAI_RELEASE_SIGNING_KEY: path.join(w.keys, 'linked.key') }).stderr, /must not be a symlink/);
  assert.match(w.sign({ JANKURAI_RELEASE_SIGNING_KEY: path.join(w.keys, 'absent.key') }).stderr, /missing/);
  const repo = path.join(w.root, 'repo'); fs.mkdirSync(repo);
  assert.equal(run(['git', 'init', '-q', repo]).status, 0);
  fs.copyFileSync(key, path.join(repo, 'k.key')); fs.chmodSync(path.join(repo, 'k.key'), 0o600);
  assert.match(w.sign({ JANKURAI_RELEASE_SIGNING_KEY: path.join(repo, 'k.key') }).stderr, /outside any Git repository/);
  fs.chmodSync(path.join(w.keys, 'password'), 0o644);
  assert.match(w.sign().stderr, /signing password file is readable/);
  fs.chmodSync(path.join(w.keys, 'password'), 0o600);
  assert.match(w.sign({ JANKURAI_RELEASE_SIGNING_PASSWORD_FILE: '' }).stderr, /COSIGN_PASSWORD or JANKURAI_RELEASE_SIGNING_PASSWORD_FILE/);
  assert.equal(fs.readdirSync(w.dist).filter(name => name.endsWith('.cosign.bundle')).length, 0, 'nothing was signed');
});

test('a key-signed inventory cannot satisfy the keyless v1.7.1 path', { skip: needsCosign }, t => {
  const w = workspace(t); assert.equal(w.sign().status, 0);
  for (const name of fs.readdirSync(w.dist)) {
    if (name.includes('1.7.2')) fs.copyFileSync(path.join(w.dist, name), path.join(w.dist, name.replace('1.7.2', '1.7.1')));
  }
  const result = w.install('v1.7.1'); assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /release signature verification failed/, 'v1.7.1 must not reach the key path');
});

test('install-public-key refuses a private key and generate-signing-key keeps keys private and out of repositories', { skip: needsCosign }, t => {
  const w = workspace(t);
  const privateKey = run(['bash', path.join(w.tooling, 'ops/release/install-public-key.sh'), path.join(w.keys, 'jankurai-release-2026.key'),
    '--name', 'jankurai-release-2026.pub'], w.env);
  assert.notEqual(privateKey.status, 0); assert.match(privateKey.stderr, /private key/);
  const generate = dir => run(['bash', path.join(w.tooling, 'ops/release/generate-signing-key.sh'), '--dir', dir, '--name', 'release-test'],
    { ...w.env, COSIGN_PASSWORD: 'throwaway' }, { input: '' });
  const dir = path.join(w.root, 'config', 'jankurai-release');
  const made = generate(dir); assert.equal(made.status, 0, made.stderr);
  assert.equal(fs.statSync(path.join(dir, 'release-test.key')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.match(made.stdout, new RegExp(`SHA-256: +${sha256(fs.readFileSync(path.join(dir, 'release-test.pub')))}`));
  assert.match(generate(dir).stderr, /refusing to overwrite/);
  const repo = path.join(w.root, 'repo'); assert.equal(run(['git', 'init', '-q', repo]).status, 0);
  assert.match(generate(path.join(repo, 'keys')).stderr, /inside a Git repository/);
});
