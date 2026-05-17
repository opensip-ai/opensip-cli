/**
 * `packageOfPath(filePath)` — derive the package name from a project-
 * relative file path. Pulled out per §11.2 (4 callers: View 4 coupling,
 * View 5 untested, View 6 SCCs, View 7 search).
 *
 * Heuristic: matches `^packages/([^/]+)/` and returns the captured group.
 * Falls back to '<unknown>' for anything that doesn't fit.
 */

export function dashboardPathUtilsJs(): string {
  return String.raw`
function packageOfPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return '<unknown>';
  const m = /^packages\/([^/]+)\//.exec(filePath);
  return m ? m[1] : '<unknown>';
}
`;
}
