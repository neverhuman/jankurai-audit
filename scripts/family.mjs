#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'recover') {
    const op = await import('./family-operation.mjs');
    op.recoverMain(['recover', ...args]);
  } else {
    const { Family } = await import('./family-model.mjs');
    const { operation, run } = await import('./family-lib.mjs');
    const { dependencies, build, check } = await import('./family-build.mjs');
    const { update } = await import('./family-update.mjs');
    const family = new Family(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    if (command === 'status') family.status();
    else if (command === 'mirror-routes') for (const [legacy, mirror] of family.legacyCrateRoutes()) console.log(`${legacy} ${mirror}`);
    else if (command === 'validate') console.log('validate-family: ok');
    else operation(family.hub, (tx) => {
      switch (command) {
        case 'setup': family.bootstrap(true); family.fuse(); dependencies(family); break;
        case 'build': build(family, { release: args.includes('--release'), target: args.includes('--target') ? args[args.indexOf('--target') + 1] : undefined }); break;
        case 'test':
        case 'check': check(family); break;
        case 'version': family.bootstrap(); family.fuse(); run(['cargo', 'run', '--locked', '-p', 'jankurai', '--', '--version'], { cwd: family.fusion }); break;
        case 'fuse': family.bootstrap(); family.fuse(); break;
        case 'pull': update(family, {}, tx); break;
        default: throw new Error('usage: family.sh {setup|pull|build|check|status|fuse|validate|mirror-routes|recover} [--release] [--target triple]');
      }
    });
  }
} catch (error) { console.error(`family: ${error.message}`); process.exitCode = 1; }
