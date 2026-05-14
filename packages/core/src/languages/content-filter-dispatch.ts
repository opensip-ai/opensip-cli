/**
 * @fileoverview Adapter-driven content filter dispatch.
 *
 * Resolves the LanguageAdapter for a file's extension and applies its
 * stripStrings or stripComments method. Falls back to returning content
 * unchanged when no adapter is registered for the extension.
 *
 * This is the boundary that lets cross-language checks (in
 * @opensip-tools/checks-universal and similar) consume "code only,
 * strings stripped" or "code only, strings + comments stripped" without
 * knowing which language a file is in.
 */

import { defaultLanguageRegistry } from './registry.js'

/**
 * Content filter modes a check can request:
 *  - 'raw' / 'none': pass content through unchanged
 *  - 'strip-strings': string literal content replaced with whitespace
 *  - 'strip-strings-and-comments': both string literals and comments replaced
 */
export type ContentFilterMode =
  | 'strip-strings'
  | 'strip-strings-and-comments'
  | 'none'
  | 'raw'

/**
 * Apply a content filter to file content, dispatching to the
 * LanguageAdapter that owns the file extension.
 *
 * When no adapter is registered for the file's extension, returns
 * the raw content unchanged. This preserves backward compatibility:
 * callers that previously processed unknown-language files (JSON,
 * YAML, plain text) keep getting raw content rather than crashing.
 */
export function applyContentFilter(
  filePath: string,
  content: string,
  mode: ContentFilterMode,
): string {
  if (mode === 'none' || mode === 'raw') return content
  const adapter = defaultLanguageRegistry.forFile(filePath)
  if (!adapter) {
    // No adapter — file is in a language we don't recognize. The check
    // author asked for stripped content, but we have no way to strip
    // safely. Return raw; the check operates as if no filter applied.
    return content
  }
  return mode === 'strip-strings'
    ? adapter.stripStrings(content)
    : adapter.stripComments(content)
}
