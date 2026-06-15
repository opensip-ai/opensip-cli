/**
 * Path / name display helpers shared across the Explore views.
 *
 * - pkgOf:         the package an occurrence belongs to — prefers the
 *   build-time-stamped `occurrence.package` (nearest package.json name, shown
 *   scope-stripped), falling back to the path heuristic for old catalogs.
 * - packageOfPath: path-only fallback (first segment under packages/).
 * - displayName:   collapse synthetic graph names like
 *   "<arrow:packages/.../foo.ts:234:45>" into a short tag the table
 *   can render without horizontal overflow. The underlying simpleName
 *   is preserved as the identity (data-body-hash); only the cell text
 *   is shortened.
 */

export function dashboardPathUtilsJs(): string {
  return String.raw`
function packageOfPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return '<unknown>';
  const m = /^packages\/([^/]+)\//.exec(filePath);
  return m ? m[1] : '<unknown>';
}

// Strip an npm scope for display: "@opensip-cli/lang-typescript" -> "lang-typescript".
function shortPkg(name) {
  if (typeof name !== 'string') return '<unknown>';
  return name.charCodeAt(0) === 64 /* @ */ ? name.slice(name.indexOf('/') + 1) : name;
}

// The package an occurrence belongs to. Prefers the build-time-stamped
// occurrence.package (accurate for any repo layout); falls back to the path
// heuristic for legacy catalogs. Scope-stripped for compact display.
function pkgOf(occ) {
  if (occ && typeof occ.package === 'string' && occ.package.length > 0) return shortPkg(occ.package);
  return packageOfPath(occ ? occ.filePath : '');
}

function displayName(simpleName) {
  if (typeof simpleName !== 'string') return '';
  // Synthetic names from the graph tool are angle-bracketed:
  //   <arrow:path:line:col>, <fn-expr:path:line:col>, <module-init:path>, <default>
  // Render just the kind tag — file:line is shown in the File column.
  const m = /^<([a-z-]+)(?::|>)/.exec(simpleName);
  if (m) return '<' + m[1] + '>';
  return simpleName;
}
`;
}
