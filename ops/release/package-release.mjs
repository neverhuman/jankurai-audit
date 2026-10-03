// Package one target's release products from a built source tree into a
// reproducible, unsigned inventory. Archive names and contents keep the v1
// layout; provenance is schema v2 (server-built, key-signed, no workflow fields).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TARGETS = ['x86_64-unknown-linux-gnu', 'aarch64-apple-darwin'];
export const PRODUCTS = ['jankurai', 'tuiwright'];
const COMPANION = /\.(sha256|cosign\.bundle)$/;
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function run(args, { cwd, capture = true } = {}) {
  const result = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`command failed (${result.status}): ${args.join(' ')}\n${result.stderr ?? ''}`);
  return capture ? result.stdout.trim() : '';
}

// Deterministic tar: fixed order, owner, mode and mtime; gzip without a timestamp.
export function reproducibleTarball(stageRoot, name, output, epoch) {
  const entries = [name, ...fs.readdirSync(path.join(stageRoot, name)).sort().map(file => `${name}/${file}`)];
  for (const entry of entries) fs.utimesSync(path.join(stageRoot, entry), epoch, epoch);
  const gnu = /GNU tar/.test(spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout ?? '');
  const owner = gnu ? ['--owner=0', '--group=0', '--numeric-owner']
    : ['--uid', '0', '--gid', '0', '--uname', '', '--gname', '', '--numeric-owner'];
  const tarFile = `${output}.tar.tmp`;
  try {
    run(['tar', '--format=ustar', ...owner, '--no-recursion', '-cf', tarFile, '-C', stageRoot, ...entries]);
    fs.writeFileSync(output, zlib.gzipSync(fs.readFileSync(tarFile), { level: 9 }));
  } finally { fs.rmSync(tarFile, { force: true }); }
}

export function writeChecksums(out) {
  for (const name of fs.readdirSync(out).sort()) {
    const file = path.join(out, name);
    if (fs.lstatSync(file).isFile() && !COMPANION.test(name) && !/\.pub$/.test(name)) {
      fs.writeFileSync(`${file}.sha256`, `${digest(file)}  ${name}\n`);
    }
  }
}

export function packageRelease({ source, target, out, tooling, tag }) {
  if (!TARGETS.includes(target)) throw new Error(`unsupported release target: ${target}`);
  const version = fs.readFileSync(path.join(source, 'VERSION'), 'utf8').trim();
  if (tag !== `v${version}`) throw new Error(`tag ${tag} does not match VERSION ${version}`);
  const git = (...args) => run(['git', '-C', source, ...args]);
  const commit = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  if (git('rev-parse', `refs/tags/${tag}^{commit}`) !== commit) throw new Error('source checkout is not the release tag');
  const epoch = Number(git('show', '-s', '--format=%ct', commit));
  const installer = path.join(tooling, 'jankurai-installer.sh');
  fs.mkdirSync(out, { recursive: true });
  for (const name of fs.readdirSync(out)) {
    if (name.includes(target) || (target === TARGETS[0] && !TARGETS.some(t => name.includes(t)))) {
      throw new Error(`output already holds ${target} assets; use a fresh directory: ${name}`);
    }
  }
  const fusion = path.join(source, '.fusion');
  const provenance = {
    schema: 'jankurai.release/v2', version, tag, target,
    repository: 'https://github.com/neverhuman/jankurai-audit',
    commit, tree, source_date_epoch: epoch,
    // jankurai embeds its crate directory (CARGO_MANIFEST_DIR), so a byte-identical
    // rebuild needs this same build root; every other asset is path-independent.
    build_root: path.dirname(source),
    family_lock_sha256: digest(path.join(source, 'family.lock')),
    cargo_lock_sha256: digest(path.join(source, 'Cargo.lock')),
    fusion_cargo_lock_sha256: digest(path.join(fusion, 'Cargo.lock')),
    components: fs.readFileSync(path.join(source, 'family.lock'), 'utf8')
      .split('[[repo]]').slice(1).map(block => ({
        repo: /repo = "([^"]+)"/.exec(block)[1], commit: /commit = "([0-9a-f]{40})"/.exec(block)[1] })),
    toolchain: {
      rustc: run(['rustc', '-vV'], { cwd: source }), cargo: run(['cargo', '--version'], { cwd: source }),
      node: process.version, npm: run(['npm', '--version'], { cwd: source }),
    },
    builder: { kind: 'server', host: `${os.type()}/${os.machine?.() ?? os.arch()}` },
    release_tooling: {
      commit: run(['git', '-C', tooling, 'rev-parse', 'HEAD']),
      clean: run(['git', '-C', tooling, 'status', '--porcelain']) === '',
      installer_sha256: digest(installer),
    },
    signing: 'cosign-key',
  };
  const provenanceFile = path.join(out, `provenance-${target}.json`);
  fs.writeFileSync(provenanceFile, JSON.stringify(provenance, null, 2) + '\n');
  const stageRoot = fs.mkdtempSync(path.join(out, '.stage-'));
  const binaries = {};
  try {
    for (const product of PRODUCTS) {
      const binary = path.join(fusion, 'target', target, 'release', product);
      const actual = run([binary, '--version']);
      if (actual !== `${product} ${version}`) throw new Error(`release binary version mismatch: ${actual}`);
      binaries[product] = digest(binary);
      const name = `${product}-${version}-${target}`, stage = path.join(stageRoot, name);
      fs.mkdirSync(stage);
      fs.chmodSync(stage, 0o755);
      const files = { [product]: binary, 'family.lock': path.join(source, 'family.lock'),
        'Cargo.lock': path.join(source, 'Cargo.lock'), LICENSE: path.join(source, 'LICENSE'), 'provenance.json': provenanceFile };
      for (const [file, from] of Object.entries(files)) {
        fs.copyFileSync(from, path.join(stage, file));
        fs.chmodSync(path.join(stage, file), file === product ? 0o755 : 0o644);
      }
      reproducibleTarball(stageRoot, name, path.join(out, `${name}.tar.gz`), epoch);
    }
  } finally { fs.rmSync(stageRoot, { recursive: true, force: true }); }
  // Platform-independent assets come from the Linux build only.
  if (target === 'x86_64-unknown-linux-gnu') {
    const packed = run(['npm', 'pack', '--silent', '--workspace', '@jankurai/ux-qa', '--pack-destination', out],
      { cwd: path.join(path.dirname(source), 'jankurai-tools-ux') }).split('\n').at(-1);
    if (packed !== `jankurai-ux-qa-${version}.tgz`) throw new Error(`unexpected UX package: ${packed}`);
    for (const [name, from] of [['family.lock', path.join(source, 'family.lock')], ['Cargo.lock', path.join(source, 'Cargo.lock')],
      ['jankurai-installer.sh', installer]]) fs.copyFileSync(from, path.join(out, name));
  }
  writeChecksums(out);
  return { provenance, binaries };
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${name}`);
  return args[index + 1];
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const result = packageRelease({ source: path.resolve(option(args, '--source')), out: path.resolve(option(args, '--out')),
      tooling: path.resolve(option(args, '--tooling')), target: option(args, '--target'), tag: option(args, '--tag') });
    console.log(JSON.stringify({ commit: result.provenance.commit, tree: result.provenance.tree, binaries: result.binaries }, null, 2));
  } catch (error) { console.error(`release packaging: ${error.message}`); process.exitCode = 1; }
}
