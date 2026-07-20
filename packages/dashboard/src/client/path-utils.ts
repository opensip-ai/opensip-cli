/**
 * Path / name display helpers shared across the Explore views.
 *
 * - pkgOf:         the package an occurrence belongs to — prefers the
 *   build-time-stamped `occurrence.package` (nearest package.json name),
 *   falling back to the path heuristic for old catalogs.
 * - packageOfPath: path-only fallback (first segment under packages/).
 * - displayName:   collapse synthetic graph names like
 *   "<arrow:packages/.../foo.ts:234:45>" into a short tag the table
 *   can render without horizontal overflow. The underlying simpleName
 *   is preserved as the identity (data-body-hash); only the cell text
 *   is shortened.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 */

import type { OccLike } from './code-paths-types.js';

export function packageOfPath(filePath: unknown): string {
  if (typeof filePath !== 'string' || filePath.length === 0) return '<unknown>';
  const m = /^packages\/([^/]+)\//.exec(filePath);
  return m ? m[1] : '<unknown>';
}

// Strip an npm scope for display: "@opensip-cli/lang-typescript" -> "lang-typescript".
export function shortPkg(name: unknown): string {
  if (typeof name !== 'string') return '<unknown>';
  return name.codePointAt(0) === 64 /* @ */ ? name.slice(name.indexOf('/') + 1) : name;
}

// The full package identity an occurrence belongs to. Keep npm scopes intact
// anywhere this value participates in matching or attribution.
export function pkgOf(occ: OccLike | null | undefined): string {
  if (occ && typeof occ.package === 'string' && occ.package.length > 0) return occ.package;
  return packageOfPath(occ ? occ.filePath : '');
}

// Explicit alias for call sites where identity-vs-display is worth spelling out.
export const packageIdentityOf = pkgOf;

export function displayName(simpleName: unknown): string {
  if (typeof simpleName !== 'string') return '';
  // Synthetic names from the graph tool are angle-bracketed:
  //   <arrow:path:line:col>, <fn-expr:path:line:col>, <module-init:path>, <default>
  // Render just the kind tag — file:line is shown in the File column.
  const m = /^<([a-z-]+)[:>]/.exec(simpleName);
  if (m) return '<' + m[1] + '>';
  return simpleName;
}
