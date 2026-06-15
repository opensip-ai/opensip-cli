/**
 * @fileoverview No raw fetch check — flags direct `fetch()` calls that should
 * use a wrapped HTTP client.
 */

import { defineCheck, isCommentLine, isTestFile, type CheckViolation } from '@opensip-cli/fitness';

/**
 * Pattern for detecting raw fetch() calls.
 *
 * Safe regex: bounded whitespace + a single negative lookbehind that
 * rejects any identifier-char or `.` immediately before `fetch`. The
 * lookbehind excludes both larger identifiers ending in `fetch`
 * (`prefetch`, `recordReconcilerPrefetch`, `MyClass.fetch`) AND any
 * dotted call (`this.fetch`, `cacheGit.fetch`, `httpClient.fetch`) in
 * one rule — there's no need for a separate `this.` exclusion.
 *
 * The previous form `(?<!this\.)fetch...` had no word-boundary on the
 * left, so anything ending in `fetch(` matched (false positives on
 * `prefetch(`, `recordReconcilerPrefetch(`, etc.).
 */
const RAW_FETCH_PATTERN = /(?<![\w$.])fetch\s{0,10}\(/g;

/**
 * Check: resilience/no-raw-fetch
 *
 * Detects direct use of fetch() without retry/timeout wrapper.
 */
export const noRawFetch = defineCheck({
  id: 'cfeba2d8-0f62-4b64-b625-f5ba8a0f3b11',
  slug: 'no-raw-fetch',
  fileTypes: ['ts', 'tsx', 'js', 'jsx'],
  description: 'Detect direct fetch() calls that should use wrapped HTTP clients',
  longDescription: `**Purpose:** Enforces use of the platform HTTP client wrapper instead of raw \`fetch()\` calls.

**Detects:**
- Bare \`fetch(\` calls via regex \`(?<![\\w$.])fetch\\s{0,10}\\(\` (excludes any \`<ident>.fetch\` method call AND any larger identifier ending in \`fetch\`, e.g. \`prefetch\`)
- Skips comment lines

**Why it matters:** Raw \`fetch()\` lacks built-in retry, timeout, observability, and error normalization that the canonical HttpClient provides.

**Scope:** Codebase-specific convention. Analyzes each file individually via regex.`,
  tags: ['resilience', 'http', 'fetch'],

  analyze(content: string, filePath: string): CheckViolation[] {
    const violations: CheckViolation[] = [];

    // Quick check: skip files that don't contain fetch
    if (!content.includes('fetch(')) {
      return violations;
    }

    // Skip the resilient fetch wrapper itself — this IS the raw fetch implementation
    if (filePath.includes('resilient-fetch') || filePath.includes('resilient_fetch')) {
      return violations;
    }

    // Skip test files — tests legitimately invoke `fetch(` directly to
    // exercise the wrapper, mock the global, or hit a localhost test
    // server. Routing those through the wrapper would defeat the test.
    if (isTestFile(filePath)) {
      return violations;
    }

    // Skip fitness check definitions that reference fetch in string/regex patterns
    if (filePath.includes('/fitness/src/checks/')) {
      return violations;
    }

    // Skip LLM adapter files — infrastructure boundary making direct API calls
    if (filePath.includes('/llm/') || filePath.includes('/llm-adapter')) {
      return violations;
    }

    // Skip SSE/streaming implementations that require raw fetch for stream parsing
    if (
      content.includes('ReadableStream') ||
      content.includes('text/event-stream') ||
      content.includes('EventSource') ||
      content.includes('getReader()')
    ) {
      return violations;
    }

    // Skip files where fetch() is invoked through a retry wrapper AND
    // every fetch call passes an abort signal / timeout. This is the
    // canonical "wrapped" pattern: `withRetry(() => fetch(url, { signal:
    // AbortSignal.timeout(...) }))`. The check exists to flag the bare
    // primitive, not legitimate library code that already adds the
    // missing affordances around it.
    const fetchCallCount = (content.match(/(?<![\w$.])fetch\s{0,10}\(/g) ?? []).length;
    const signalCount = (content.match(/\bsignal\s*:/g) ?? []).length;
    const usesRetryWrapper =
      content.includes('withRetry(') ||
      content.includes('withRetries(') ||
      content.includes('retryFetch(');
    if (usesRetryWrapper && signalCount >= fetchCallCount) {
      return violations;
    }

    const lines = content.split('\n');

    for (const [lineNum, line_] of lines.entries()) {
      const line = line_ ?? '';

      // Skip comment lines
      if (isCommentLine(line)) {
        continue;
      }

      RAW_FETCH_PATTERN.lastIndex = 0;
      let match;
      while ((match = RAW_FETCH_PATTERN.exec(line)) !== null) {
        violations.push({
          line: lineNum + 1,
          column: match.index,
          message: 'Raw fetch() usage detected',
          severity: 'warning',
          suggestion:
            'Use a shared HTTP client wrapper with built-in retry, timeout, and error handling instead of raw fetch()',
          match: match[0],
          filePath,
        });
      }
    }

    return violations;
  },
});
