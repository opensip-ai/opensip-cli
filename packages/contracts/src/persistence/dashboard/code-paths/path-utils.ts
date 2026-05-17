/**
 * Path / name display helpers shared across the Explore views.
 *
 * - packageOfPath: derive the package name from a project-relative path.
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
