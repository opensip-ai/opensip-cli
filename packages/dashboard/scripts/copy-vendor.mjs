#!/usr/bin/env node
/**
 * Copy the committed vendor bundle into `dist/vendor/` after `tsc`.
 *
 * `tsc` does not process or copy `.js` files (allowJs is off), so the
 * committed `src/vendor/cytoscape-bundle.js` would be absent from the
 * published `dist/` tarball. The `dashboardCytoscapeVendorJs()` emitter
 * resolves the bundle next to the compiled module first; this step puts it
 * there. In the monorepo (src present) the emitter's source-tree fallback
 * also works, so this copy is what makes the PUBLISHED package self-
 * contained.
 */

import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..');

const src = join(PKG_ROOT, 'src', 'vendor', 'cytoscape-bundle.js');
const destDir = join(PKG_ROOT, 'dist', 'vendor');
const dest = join(destDir, 'cytoscape-bundle.js');

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`copied vendor bundle → ${dest}`);
