import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const installer = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'jankurai-installer.sh');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const KEY = 'jankurai-release-2026.pub', KEY_BYTES = 'fixture release public key\n';
const keySigned = version => { const [a, b, c] = version.split('.').map(Number); return a * 1e6 + b * 1e3 + c > 1007001; };
// `signer` is the repository keyless (<= v1.7.1) fixture assets were signed under;
// the installer must derive the same identity from the requested repository and tag.
// Later versions are key-signed: a release key pinned in the installer by SHA-256.
function fixture(t, platform = 'linux', { version = '1.7.1', signer = 'neverhuman/jankurai' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-ci-test-')), tools = path.join(root, 'tools');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(tools);
  const target = platform === 'linux' ? 'x86_64-unknown-linux-gnu' : 'aarch64-apple-darwin';
  const stem = `jankurai-${version}-${target}`, asset = `${stem}.tar.gz`, commit = '4'.repeat(40);
  const payload = { jankurai: `#!/bin/sh\nprintf "jankurai ${version}\\n"\n`, 'family.lock': 'family fixture', 'Cargo.lock': 'cargo fixture', LICENSE: 'MIT' };
  const signing = keySigned(version) ? 'key' : 'keyless';
  const provenance = signing === 'key'
    ? { schema: 'jankurai.release/v2', repository: 'https://github.com/neverhuman/jankurai-audit', commit, tree: '6'.repeat(40),
      tag: `v${version}`, target, version, family_lock_sha256: sha256(payload['family.lock']), cargo_lock_sha256: sha256(payload['Cargo.lock']) }
    : { schema: 'jankurai.release/v1', repository: `https://github.com/${signer}`, commit, target, version,
      family_lock_sha256: sha256(payload['family.lock']), cargo_lock_sha256: sha256(payload['Cargo.lock']) };
  const tool = (name, source) => fs.writeFileSync(path.join(tools, name), '#!/usr/bin/env node\n' + source, { mode: 0o755 });
  tool('uname', `console.log(process.argv[2] === '-s' ? '${platform === 'linux' ? 'Linux' : 'Darwin'}' : '${platform === 'linux' ? 'x86_64' : 'arm64'}');`);
  tool('curl', "const fs=require('node:fs'),path=require('node:path'),a=process.argv; const url=a.find(x=>x.startsWith('https:')); fs.appendFileSync(path.join(process.env.FIXTURE_ROOT,'fetched.log'),url+'\\n'); fs.copyFileSync(path.join(process.env.FIXTURE_ROOT,url.split('/').at(-1)),a[a.indexOf('-o')+1]);");
  const gh = `const a=process.argv; const value=k=>a[a.indexOf(k)+1];
    if(a[2]!=='attestation' || a[3]!=='verify') throw new Error('API access forbidden');
    for(const key of ['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN']) if(process.env[key]) throw new Error('credentials inherited');
    if(['--cert-identity','--cert-identity-regex','--signer-repo','--signer-workflow'].filter(flag=>a.includes(flag)).length!==1) throw new Error('mutually exclusive GitHub verification flags');
    if(!a.includes('--bundle') || !a.includes('--deny-self-hosted-runners') || value('--cert-identity')!==process.env.FIXTURE_IDENTITY || value('--cert-oidc-issuer')!=='https://token.actions.githubusercontent.com' || value('--repo')!==process.env.FIXTURE_REPO || value('--source-ref')!=='refs/tags/v'+process.env.FIXTURE_VERSION || value('--source-digest')!==process.env.FIXTURE_COMMIT || value('--signer-digest')!==process.env.FIXTURE_COMMIT) throw new Error('attestation identity mismatch');
    if(process.env.ATTESTATION_FAILURE) throw new Error('attestation rejected');`;
  const cosign = `const fs=require('node:fs'),a=process.argv,value=k=>a[a.indexOf(k)+1];
    if(a.includes('--key')){
      if(a.some(x=>x.startsWith('--certificate'))) throw new Error('mixed key and keyless verification');
      if(!value('--key').endsWith('/${KEY}') || fs.readFileSync(value('--key'),'utf8')!==${JSON.stringify(KEY_BYTES)} || !value('--bundle').endsWith('.cosign.bundle') || !a.includes('--insecure-ignore-tlog=true') || !a.includes('--offline=true')) throw new Error('wrong key verification');
    } else if(value('--certificate-identity')!==process.env.FIXTURE_IDENTITY || value('--certificate-oidc-issuer')!=='https://token.actions.githubusercontent.com') throw new Error('wrong signature identity');
    if(process.env.SIGNATURE_FAILURE) throw new Error('signature rejected');`;
  const archiveRoot = `gh_2.100.0_${platform === 'linux' ? 'linux_amd64' : 'macOS_arm64'}`;
  fs.mkdirSync(path.join(root, archiveRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, archiveRoot, 'bin/gh'), '#!/usr/bin/env node\n'+gh);
  const ghArchive = archiveRoot + (platform === 'linux' ? '.tar.gz' : '.zip');
  const packed = platform === 'linux'
    ? spawnSync('tar', ['-czf', path.join(root, ghArchive), '-C', root, archiveRoot])
    : spawnSync('zip', ['-q', '-r', ghArchive, archiveRoot], { cwd: root });
  assert.equal(packed.status, 0);
  const cosignAsset = platform === 'linux' ? 'cosign-linux-amd64' : 'cosign-darwin-arm64';
  fs.writeFileSync(path.join(root, cosignAsset), '#!/usr/bin/env node\n'+cosign);
  const jqAsset = platform === 'linux' ? 'jq-linux-amd64' : 'jq-macos-arm64';
  const jqPath = spawnSync('sh', ['-c', 'command -v jq'], { encoding:'utf8' }).stdout.trim();
  fs.copyFileSync(jqPath, path.join(root, jqAsset));
  // Only the disposable test copy pins the controlled verifier fixture bytes.
  // Production never accepts a verifier override or skips a hash check.
  const hashes = platform === 'linux' ? [
    'e4d4bb4498e8d007abe545b6568926793ace1b6447da598294a610018cb164be',
    '4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71',
    'b1c22172dd303f3be49e935aa56aa48a8b7a46e0bc838b4997d3bb451495870f'
  ] : [
    '45f9a62da2f6e641a7fad57e2ce39656dfd7ef331372d80a2a2aed65abb01642',
    '5cf948c2f4dfe59687bdd0b8523709067383e03982cc543475c8a7dc70e92a76',
    '2d75340ba57a4b4b4c8708a21c2dc8e958a48aaa8bba13b27f77f6e4c0eca07e'
  ];
  let source = fs.readFileSync(installer, 'utf8');
  for (const [i, name] of [ghArchive, cosignAsset, jqAsset].entries()) {
    assert.ok(source.includes(hashes[i]));
    source = source.replace(hashes[i], sha256(fs.readFileSync(path.join(root, name))));
  }
  // Pin the fixture release key exactly as install-public-key.sh would.
  assert.match(source, new RegExp(`^${KEY.replace('.', '\\.')}\\|[0-9a-f]{64}\\|v1\\.7\\.2\\|$`, 'm'));
  source = source.replace(new RegExp(`^${KEY.replace('.', '\\.')}\\|[0-9a-f]{64}\\|`, 'm'), `${KEY}|${sha256(KEY_BYTES)}|`);
  const testInstaller = path.join(root, 'installer.sh'); fs.writeFileSync(testInstaller, source);
  const env = { ...process.env, PATH: tools + path.delimiter + process.env.PATH, FIXTURE_ROOT: root,
    GH_TOKEN: 'fixture-credential-must-not-be-used', GITHUB_TOKEN: 'fixture-credential-must-not-be-used',
    FIXTURE_COMMIT: commit, FIXTURE_REPO: signer, FIXTURE_VERSION: version,
    FIXTURE_IDENTITY: `https://github.com/${signer}/.github/workflows/release.yml@refs/tags/v${version}` };
  function pack(extra) {
    const stage = path.join(root, stem);
    fs.mkdirSync(stage, { recursive: true });
    for (const [name, contents] of Object.entries({ ...payload, 'provenance.json': JSON.stringify(provenance) })) fs.writeFileSync(path.join(stage, name), contents);
    if (extra) extra(stage);
    const result = spawnSync('tar', ['-czf', path.join(root, asset), '-C', root, stem]);
    assert.equal(result.status, 0);
    fs.writeFileSync(path.join(root, asset + '.sha256'), sha256(fs.readFileSync(path.join(root, asset))) + '  ' + asset + '\n');
    const companions = signing === 'key' ? ['.cosign.bundle'] : ['.sigstore.bundle', '.attestation.jsonl'];
    for (const suffix of companions) fs.writeFileSync(path.join(root, asset + suffix), 'controlled verifier fixture');
    if (signing === 'key') fs.writeFileSync(path.join(root, KEY), KEY_BYTES);
  }
  const fetched = () => { try { return fs.readFileSync(path.join(root, 'fetched.log'), 'utf8'); } catch { return ''; } };
  const run = (...args) => spawnSync('bash', [testInstaller, '--tag', `v${version}`, ...args], { env, encoding: 'utf8' });
  const install = (...args) => run('--verify-only', ...args);
  return { root, asset, payload, provenance, env, pack, install, run, ghArchive, cosignAsset, version, fetched, testInstaller };
}
test('valid keyless asset requires both exact workflow verification identities', t => {
  const f = fixture(t); f.pack(); const result = f.install();
  assert.equal(result.status, 0, result.stderr);
});
test('checksum tampering is rejected', t => {
  const f = fixture(t); f.pack(); fs.appendFileSync(path.join(f.root, f.asset), 'tampered');
  const result = f.install(); assert.notEqual(result.status, 0); assert.match(result.stderr, /checksum mismatch/);
});
test('provenance commit mismatch is rejected with a matching checksum', t => {
  const f = fixture(t); f.provenance.commit = '5'.repeat(40); f.pack();
  const result = f.install(); assert.notEqual(result.status, 0); assert.match(result.stderr, /attestation identity mismatch/);
});
test('embedded lock tampering is rejected', t => {
  const f = fixture(t); f.payload['family.lock'] = 'different family'; f.pack();
  const result = f.install(); assert.notEqual(result.status, 0); assert.match(result.stderr, /lock provenance mismatch/);
});
test('failed attestation or signature prevents installation', t => {
  const f = fixture(t); f.pack();
  for (const key of ['ATTESTATION_FAILURE', 'SIGNATURE_FAILURE']) {
    f.env[key] = 'yes'; assert.notEqual(f.install().status, 0); delete f.env[key];
  }
});
test('linked archive payload is rejected before extraction', t => {
  const f = fixture(t); f.pack(stage => { fs.unlinkSync(path.join(stage, 'jankurai')); fs.symlinkSync('../escape', path.join(stage, 'jankurai')); });
  const result = f.install(); assert.notEqual(result.status, 0); assert.match(result.stderr, /unsafe archive entry/);
});
test('unexpected archive inventory is rejected', t => {
  const f = fixture(t); f.pack(stage => fs.writeFileSync(path.join(stage, 'unwanted'), 'data'));
  const result = f.install(); assert.notEqual(result.status, 0); assert.match(result.stderr, /archive inventory/);
});

test('macOS bootstrap extracts the pinned verifier from zip', t => {
  const f = fixture(t, 'macos'); f.pack(); const result = f.install();
  assert.equal(result.status, 0, result.stderr);
});
test('tampered verifier download is rejected before execution', t => {
  const f = fixture(t); f.pack(); fs.appendFileSync(path.join(f.root, f.cosignAsset), 'tampered');
  const result = f.install(); assert.notEqual(result.status, 0); assert.match(result.stderr, /verification tool checksum mismatch/);
});
test('installation atomically replaces an existing binary only after verification', t => {
  const f = fixture(t); f.pack(); const dir = path.join(f.root, 'installed'); fs.mkdirSync(dir);
  const installed = path.join(dir, 'jankurai'); fs.writeFileSync(installed, 'existing');
  for (const key of ['ATTESTATION_FAILURE', 'SIGNATURE_FAILURE']) {
    f.env[key]='yes'; assert.notEqual(f.run('--install-dir', dir).status, 0);
    assert.equal(fs.readFileSync(installed, 'utf8'), 'existing'); delete f.env[key];
  }
  f.payload.jankurai = '#!/bin/sh\nprintf "jankurai 1.6.0\\n"\n'; f.pack();
  assert.notEqual(f.run('--install-dir', dir).status, 0); assert.equal(fs.readFileSync(installed, 'utf8'), 'existing');
  f.payload.jankurai = '#!/bin/sh\nexit 1\n'; f.pack();
  assert.notEqual(f.run('--install-dir', dir).status, 0); assert.equal(fs.readFileSync(installed, 'utf8'), 'existing');
  f.payload.jankurai = `#!/bin/sh\nprintf "jankurai ${f.version}\\n"\n`; f.pack();
  const result = f.run('--install-dir', dir); assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(installed, 'utf8'), f.payload.jankurai);
  assert.deepEqual(fs.readdirSync(dir), ['jankurai']);
});

// Releases up to v1.7.1 were signed before the hub was renamed, so their
// certificates name neverhuman/jankurai; they keep that keyless path exactly.
for (const [version, repo] of [['1.7.1', undefined], ['1.7.0', 'neverhuman/jankurai'], ['1.7.1', 'neverhuman/jankurai-audit']]) {
  test(`v${version} from ${repo ?? 'the default repository'} verifies under the pre-rename keyless identity`, t => {
    const f = fixture(t, 'linux', { version, signer: 'neverhuman/jankurai' }); f.pack();
    const result = repo ? f.install('--repo', repo) : f.install();
    assert.equal(result.status, 0, result.stderr);
    assert.match(f.fetched(), /cli\/cli\/releases/);
    assert.match(f.fetched(), /\.sigstore\.bundle/);
  });
}
test('v1.7.1 signed under the renamed identity is rejected', t => {
  const f = fixture(t, 'linux', { version: '1.7.1', signer: 'neverhuman/jankurai-audit' }); f.pack();
  const result = f.install(); assert.notEqual(result.status, 0); assert.match(result.stderr, /wrong signature identity/);
});
test('provenance naming the other hub repository is rejected', t => {
  const f = fixture(t); f.provenance.repository = 'https://github.com/neverhuman/jankurai-audit'; f.pack();
  const result = f.install(); assert.notEqual(result.status, 0); assert.match(result.stderr, /release provenance mismatch/);
});
test('another repository is verified as itself at a keyless version', t => {
  const f = fixture(t, 'linux', { version: '1.7.1', signer: 'example/fork' }); f.pack();
  const result = f.install('--repo', 'example/fork'); assert.equal(result.status, 0, result.stderr);
});

// v1.7.2 and later: checksum plus a key signature against the pinned key, no attestation.
const keyed = (t, platform = 'linux') => fixture(t, platform, { version: '1.7.2' });
test('v1.7.2 verifies with the pinned release key and never fetches GitHub CLI or attestations', t => {
  const f = keyed(t); f.pack(); const result = f.install();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(f.fetched(), /cli\/cli|attestation|sigstore\.bundle/);
  assert.match(f.fetched(), /\.cosign\.bundle/);
  assert.match(f.fetched(), new RegExp(`/v1\\.7\\.2/${KEY.replace('.', '\\.')}`));
});
test('v1.7.2 under the old repository name still verifies with the release key', t => {
  const f = keyed(t); f.pack();
  const result = f.install('--repo', 'neverhuman/jankurai'); assert.equal(result.status, 0, result.stderr);
});
test('v1.7.2 key path on macOS', t => {
  const f = keyed(t, 'macos'); f.pack(); const result = f.install();
  assert.equal(result.status, 0, result.stderr);
});
test('key path: tampered asset is rejected', t => {
  const f = keyed(t); f.pack(); fs.appendFileSync(path.join(f.root, f.asset), 'tampered');
  const result = f.install(); assert.notEqual(result.status, 0); assert.match(result.stderr, /checksum mismatch/);
});
test('key path: failed signature prevents installation', t => {
  const f = keyed(t); f.pack(); f.env.SIGNATURE_FAILURE = 'yes';
  const result = f.install(); assert.notEqual(result.status, 0); assert.match(result.stderr, /release signature verification failed/);
});
test('key path: a downloaded key that does not match the pin is rejected', t => {
  const f = keyed(t); f.pack(); fs.writeFileSync(path.join(f.root, KEY), 'attacker key\n');
  const result = f.install(); assert.notEqual(result.status, 0); assert.match(result.stderr, /does not match its pin/);
});
test('key path: a missing signature bundle is rejected', t => {
  const f = keyed(t); f.pack(); fs.unlinkSync(path.join(f.root, f.asset + '.cosign.bundle'));
  const result = f.install(); assert.notEqual(result.status, 0);
});
test('key path: keyless-only assets for v1.7.2 are rejected', t => {
  const f = keyed(t); f.pack(); fs.unlinkSync(path.join(f.root, f.asset + '.cosign.bundle'));
  for (const suffix of ['.sigstore.bundle', '.attestation.jsonl']) fs.writeFileSync(path.join(f.root, f.asset + suffix), 'keyless');
  assert.notEqual(f.install().status, 0);
});
test('key path: v1 provenance or a different tag is rejected', t => {
  const f = keyed(t); f.provenance.schema = 'jankurai.release/v1'; f.pack();
  assert.match(f.install().stderr, /release provenance mismatch/);
  f.provenance.schema = 'jankurai.release/v2'; f.provenance.tag = 'v1.7.3'; f.pack();
  assert.match(f.install().stderr, /release provenance mismatch/);
});
test('key path: embedded lock tampering is rejected', t => {
  const f = keyed(t); f.payload['family.lock'] = 'different family'; f.pack();
  const result = f.install(); assert.notEqual(result.status, 0); assert.match(result.stderr, /lock provenance mismatch/);
});
test('an unprovisioned (all-zero) key pin refuses every key-signed tag', t => {
  const f = keyed(t); f.pack();
  const source = fs.readFileSync(f.testInstaller, 'utf8').replace(/^(jankurai-release-2026\.pub\|)[0-9a-f]{64}\|/m, `$1${'0'.repeat(64)}|`);
  fs.writeFileSync(f.testInstaller, source);
  const result = f.install(); assert.notEqual(result.status, 0); assert.match(result.stderr, /not provisioned/);
});
test('rotation: each tag selects exactly the key whose range covers it', t => {
  const f = keyed(t); f.pack();
  const source = fs.readFileSync(f.testInstaller, 'utf8');
  // Close the 2026 key at v1.7.1 so nothing covers v1.7.2.
  fs.writeFileSync(f.testInstaller, source.replace(/^(jankurai-release-2026\.pub\|[0-9a-f]{64}\|v1\.7\.2\|)$/m, 'jankurai-release-2026.pub|' + sha256(KEY_BYTES) + '|v1.7.2|v1.7.1'));
  assert.match(f.install().stderr, /no release signing key covers v1\.7\.2/);
  // Overlapping ranges are refused rather than guessed.
  fs.writeFileSync(f.testInstaller, source.replace(/^(jankurai-release-2026\.pub\|[0-9a-f]{64}\|v1\.7\.2\|)$/m, '$1\nnext.pub|' + '1'.repeat(64) + '|v1.7.0|'));
  assert.match(f.install().stderr, /more than one release signing key covers v1\.7\.2/);
});
test('the committed release key matches its installer pin, or both are unprovisioned placeholders', () => {
  const source = fs.readFileSync(installer, 'utf8');
  const [, pin] = /^jankurai-release-2026\.pub\|([0-9a-f]{64})\|v1\.7\.2\|$/m.exec(source);
  const key = fs.readFileSync(path.join(path.dirname(installer), 'release-keys', KEY));
  if (/^0{64}$/.test(pin)) assert.match(key.toString(), /^PLACEHOLDER/);
  else { assert.equal(sha256(key), pin); assert.match(key.toString(), /^-----BEGIN PUBLIC KEY-----\n/); }
});
