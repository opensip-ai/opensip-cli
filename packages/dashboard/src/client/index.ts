/**
 * Dashboard client-bundle entry (L4 migration).
 *
 * Modules migrated out of the legacy `String.raw` emitters are imported here and
 * bundled (esbuild, IIFE) by `scripts/bundle-client.mjs` into one inlined
 * `<script>` chunk that `generator.ts` emits BEFORE the remaining string-emitted
 * modules.
 *
 * ## The bridge (incremental migration)
 * The legacy modules still run as concatenated strings in the SAME `<script>`
 * scope and call helpers like `el` as free identifiers. Until they too move into
 * this bundle, each migrated helper is re-exposed on `window` here so those
 * free-identifier references keep resolving. As modules migrate in, they import
 * the helper directly and the corresponding `window.*` assignment is removed.
 */

import { el } from './el.js';

// Expose `el` as a page global so the still-string-emitted client modules (which
// run in the same <script> scope and call it by bare name) keep resolving it
// during the incremental L4 migration. A local cast avoids polluting the global
// type surface; as modules migrate into this bundle they import `el` directly and
// this assignment shrinks away.
(globalThis as typeof globalThis & { el: typeof el }).el = el;
