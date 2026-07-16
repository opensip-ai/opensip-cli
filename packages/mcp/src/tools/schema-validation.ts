/** Pure validation helpers shared by MCP input schemas. */

export { hasControlCharacter } from '../control-text.js';

function projectRelativePathProblem(posix: string): string | undefined {
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix) || posix.startsWith('//')) {
    return 'file must be a project-relative path (not absolute)';
  }
  const segments = posix.split('/');
  return segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ? 'file must not contain empty, ".", or ".." path segments'
    : undefined;
}

/** Normalize valid client paths without using exceptions as validation control flow. */
export function safeNormalizeProjectRelativePath(raw: string): string | undefined {
  const posix = raw.replaceAll('\\', '/');
  return projectRelativePathProblem(posix) === undefined ? posix : undefined;
}
