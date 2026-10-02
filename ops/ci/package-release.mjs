import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { run, temporaryCI } from '../../scripts/family-lib.mjs';

const hub = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const target = process.argv[2], version = fs.readFileSync(path.join(hub, 'VERSION'), 'utf8').trim();
const dist = path.join(hub, 'dist'), digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try {
  if (!['x86_64-unknown-linux-gnu', 'aarch64-apple-darwin'].includes(target)) throw new Error('unsupported release target');
  fs.mkdirSync(dist, { recursive: true });
  const output = args => run(args, { cwd: hub, capture: true });
  const provenance = { schema: 'jankurai.release/v1', version, target,
    repository: 'https://github.com/neverhuman/jankurai-audit', commit: output(['git', 'rev-parse', 'HEAD']),
    family_lock_sha256: digest(path.join(hub, 'family.lock')), cargo_lock_sha256: digest(path.join(hub, 'Cargo.lock')),
    rustc: output(['rustc', '--version']), cargo: output(['cargo', '--version']), node: process.version,
    workflow_run: process.env.GITHUB_RUN_ID ?? null };
  const provenanceFile = path.join(dist, `provenance-${target}.json`);
  fs.writeFileSync(provenanceFile, JSON.stringify(provenance, null, 2) + '\n');
  for (const binary of ['jankurai', 'tuiwright']) {
    const source = path.join(hub, '.fusion/target', target, 'release', binary), actual = output([source, '--version']);
    if (actual !== `${binary} ${version}`) throw new Error(`release binary version mismatch: ${actual}`);
    temporaryCI(dist, 'release-stage-', temporary => {
      const name = `${binary}-${version}-${target}`, stage = path.join(temporary, name);
      fs.mkdirSync(stage);
      fs.copyFileSync(source, path.join(stage, binary));
      fs.chmodSync(path.join(stage, binary), 0o755);
      for (const metadata of ['family.lock', 'Cargo.lock', 'LICENSE']) fs.copyFileSync(path.join(hub, metadata), path.join(stage, metadata));
      fs.copyFileSync(provenanceFile, path.join(stage, 'provenance.json'));
      run(['tar', '-czf', path.join(dist, `${name}.tar.gz`), '-C', temporary, name]);
    });
  }
  if (target === 'x86_64-unknown-linux-gnu') {
    run(['npm', 'pack', '--workspace', '@jankurai/ux-qa', '--pack-destination', dist], { cwd: path.join(hub, '../jankurai-tools-ux') });
    for (const metadata of ['family.lock', 'Cargo.lock', 'jankurai-installer.sh']) fs.copyFileSync(path.join(hub, metadata), path.join(dist, metadata));
  }
  for (const name of fs.readdirSync(dist)) {
    const file = path.join(dist, name);
    if (fs.statSync(file).isFile() && !/\.(sha256|sigstore\.bundle)$/.test(name)) fs.writeFileSync(`${file}.sha256`, `${digest(file)}  ${name}\n`);
  }
} catch (error) { console.error(`release packaging: ${error.message}`); process.exitCode = 1; }
