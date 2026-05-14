/**
 * @fileoverview File type filtering for per-check file extension matching
 *
 * Filters matched files by extension based on a check's declared fileTypes.
 */

import * as path from 'node:path'

/**
 * Filter files by extension based on a check's declared fileTypes.
 * If fileTypes is undefined or empty, returns all files (universal).
 */
export function filterFilesByType(
  files: readonly string[],
  fileTypes: readonly string[] | undefined,
): string[] {
  if (!fileTypes || fileTypes.length === 0) {
    return [...files]
  }
  const extensions = new Set(fileTypes)
  return files.filter((f) => {
    const ext = path.extname(f).slice(1) // remove leading dot
    return extensions.has(ext)
  })
}
