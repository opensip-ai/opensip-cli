/**
 * @fileoverview Adapter-driven content filter dispatch.
 *
 * Resolves the LanguageAdapter for a file's extension and applies its
 * stripStrings or stripComments method. Falls back to returning content
 * unchanged when no adapter is registered for the extension.
 *
 * This is the boundary that lets cross-language checks (in
 * @opensip-cli/checks-universal and similar) consume "code only,
 * strings stripped" or "code only, strings + comments stripped" without
 * knowing which language a file is in.
 */

import { logger } from '../lib/logger.js';
import { currentScope } from '../lib/run-scope.js';

/**
 * One-shot guard so the degradation warning fires at most once per process.
 * The condition is process-global (a missing scope or duplicate core affects
 * every subsequent call identically), so repeating the warning adds only noise.
 */
let warnedFilterDegraded = false;

/**
 * Test-only reset of the one-shot degradation-warning guard. Production never
 * calls this; tests use it to assert the warn-once behavior deterministically
 * regardless of cross-test ordering.
 */
export function resetContentFilterWarningForTests(): void {
  warnedFilterDegraded = false;
}

/**
 * Content filter modes a check can request:
 *  - 'raw' / 'none': pass content through unchanged
 *  - 'strip-strings': string literal content replaced with whitespace
 *  - 'strip-strings-and-comments': both string literals and comments replaced
 */
export type ContentFilterMode = 'strip-strings' | 'strip-strings-and-comments' | 'none' | 'raw';

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
  if (mode === 'none' || mode === 'raw') return content;

  const scope = currentScope();
  if (!scope) {
    // No active RunScope at all. Two cases land here:
    //   1. A unit test calling `check.run` directly (documented, benign).
    //   2. A DUPLICATE @opensip-cli/core instance — the engine DID call
    //      runWithScope, but on a different core copy than the one running
    //      this code, so its AsyncLocalStorage store is invisible here. This
    //      happens when a globally-installed CLI loads check packs from a
    //      project that also vendors @opensip-cli packages.
    // Either way we can't strip safely, so we degrade to raw — but a check
    // that asked for stripping and silently gets raw will match patterns
    // inside string literals/comments (false positives). Warn once so the
    // degradation is observable instead of mysterious. (Case 2 is also
    // refused outright at pack-load time; see discovery's single-core guard.)
    if (!warnedFilterDegraded) {
      warnedFilterDegraded = true;
      logger.warn('content filter degraded to raw — no active run scope', {
        evt: 'core.content_filter.degraded',
        module: 'core:content-filter',
        mode,
        hint: 'A check requested string/comment stripping but no RunScope is active. If you are running a globally-installed opensip-cli inside a project that also installs @opensip-cli packages, duplicate core instances split the scope — prefer the project-local CLI (e.g. `pnpm fit`). Results may contain false positives.',
      });
    }
    return content;
  }

  const adapter = scope.languages.forFile(filePath);
  if (!adapter) {
    // Scope is present but no adapter owns this extension — a genuinely
    // unknown language (JSON/YAML/plain text). Returning raw is correct and
    // expected here, so this path stays silent.
    return content;
  }
  return mode === 'strip-strings' ? adapter.stripStrings(content) : adapter.stripComments(content);
}
