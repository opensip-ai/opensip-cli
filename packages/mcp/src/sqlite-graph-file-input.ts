/**
 * Shared file-input caps and project-path safety for the SQLite graph read
 * port's file-driven queries (impact and test selection). One definition so
 * the sibling query modules and the port validate identically.
 */

/** Max explicit files accepted by a file-driven graph read. */
export const MAX_CONTEXT_FILES = 128;
/** Max traversal depth accepted by a file-driven graph read. */
export const MAX_CONTEXT_DEPTH = 5;
/** Max result rows accepted by a file-driven graph read. */
export const MAX_CONTEXT_ROWS = 500;
/** Reason code for rejected caller input. */
export const INVALID_INPUT = 'invalid-input';

/** Is `file` a safe project-relative POSIX path (no absolute/drive/dot segments)? */
export function safeProjectFile(file: string): boolean {
  const normalized = file.replaceAll('\\', '/');
  return (
    normalized.length > 0 &&
    normalized.length <= 1024 &&
    !normalized.startsWith('/') &&
    !/^[A-Za-z]:/u.test(normalized) &&
    !/\p{Cc}/u.test(normalized) &&
    normalized.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}
