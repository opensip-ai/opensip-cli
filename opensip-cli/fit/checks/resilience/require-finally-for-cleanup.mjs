/**
 * Local-only resilience mechanism (project layout under opensip-cli/fit/checks/).
 * NEVER ship in published @opensip-cli/checks-* packs.
 *
 * Heuristic guard: code that acquires resources (timers, abort controllers, file handles,
 * temp paths, connections, listeners) must release them in a `finally` block or on
 * explicit abort paths. This prevents leaks when runWithTimeout aborts, recipes fail,
 * or signals fire.
 *
 * Allow-list escape: add a trailing comment `// resilience-ok` or `// resilience-ok: <reason>`
 * on the acquire line or the try block.
 */

import { defineCheck } from '@opensip-cli/fitness';

export const requireFinallyForCleanup = defineCheck({
  id: '8c5eccd6-a15d-4d1b-ad23-bf995e436c15',
  slug: 'require-finally-for-cleanup',
  description:
    'Acquire/release (setTimeout/AbortController, fs temps, connections, listeners) must be released in finally {} or on abort. Heuristic; production hot paths and abortable units are in scope.',
  tags: ['resilience', 'cleanup', 'abort'],
  analyze(content, filePath) {
    const violations = [];
    // First-party TypeScript source only. Generated/vendored `.js` (coverage,
    // bundles) is not ours; React/Ink `.tsx` cleans up via effect teardown, not
    // try/finally, so it is out of scope for this heuristic.
    if (!/\.ts$/.test(filePath) || /\.d\.ts$/.test(filePath)) return violations;
    if (
      /node_modules|\/dist\/|\/coverage\/|\/__tests__\/|\.test\.ts$|\/vendor\/|resilience\/|perf\/|persistence\//.test(
        filePath,
      )
    )
      return violations;
    // Check packs (`checks-*/src/checks/`) contain acquire keywords as DETECTION
    // patterns/docs (e.g. no-eval's `setInterval('string')` example), not real
    // acquires — skip them.
    if (/\/checks-[a-z]+\/src\/checks\//.test(filePath)) return violations;

    const lines = content.split(/\r?\n/);
    const hasFinally = /\bfinally\s*\{/.test(content);
    // A resource is "handled" if the file ALSO releases it somewhere (even
    // outside a finally — e.g. an Ink effect teardown / explicit clear). Only an
    // acquire with NO release anywhere in the file is a genuine leak smell.
    const hasRelease =
      /\bclearTimeout\s*\(|\bclearInterval\s*\(|\.abort\s*\(|\.unref\s*\(|\.destroy\s*\(|\.dispose\s*\(|\.close\s*\(|removeEventListener\s*\(|\boff\s*\(|\brmSync\s*\(|\brmdirSync\s*\(|\bunlinkSync\s*\(|\brm\s*\(|\bunlink\s*\(/.test(
        content,
      );
    if (hasFinally || hasRelease) return violations;

    // Genuinely-leaky acquires that REQUIRE explicit release (a skipped release
    // on abort/timeout/error leaks the handle). Event listeners and one-shot
    // `on(...)` handlers are intentionally excluded — they rarely need finally
    // and were the bulk of the false positives.
    const acquirePatterns = [
      /\bnew AbortController\s*\(/,
      /\bsetInterval\s*\(/,
      /\bsetTimeout\s*\([^)]*,\s*\d{3,}/, // long timers (>=100ms) — short one-shots rarely leak
      /createWriteStream\s*\(|createReadStream\s*\(/,
      /\bmkdtemp(Sync)?\s*\(/,
      /\bnew WebSocket\b|\bnew EventSource\b/,
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/\/\/\s*resilience-ok\b/.test(line)) continue;
      if (!acquirePatterns.some((re) => re.test(line))) continue;
      violations.push({
        line: i + 1,
        message: `Acquire of a leaky resource (timer/AbortController/stream/temp) with NO finally and NO release call (clearTimeout/.abort/.close/.dispose/…) anywhere in the file. On abort/timeout/error the release is skipped. Add finally { … } / an explicit release, or // resilience-ok with justification.`,
        severity: 'warning',
      });
    }

    return violations;
  },
});

export default requireFinallyForCleanup;
