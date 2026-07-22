/**
 * @fileoverview Shared fixture-project seeder for the platform-acceptance
 * journeys (`journeys/macos.mjs`, `journeys/resilience.mjs`, and any other
 * journey module that needs a minimal on-disk project for `fit` to flag).
 *
 * Dependency-free apart from Node built-ins so it can be imported directly by
 * journey modules with no build step.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Seed a minimal TS project (a single console.log file fit will flag) under `dir`. */
export function seedProject(dir) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'bad.ts'), "console.log('debug');\n");
  writeFileSync(
    join(dir, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext' } }, null, 2)}\n`,
  );
}
