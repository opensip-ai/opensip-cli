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

export const requireFinallyForCleanup = {
  id: "local:resilience-require-finally-for-cleanup",
  slug: "require-finally-for-cleanup",
  description:
    "Acquire/release (setTimeout/AbortController, fs temps, connections, listeners) must be released in finally {} or on abort. Heuristic; production hot paths and abortable units are in scope.",
  tags: ["resilience", "cleanup", "abort"],
  analyze(content, filePath) {
    const violations = [];
    if (!/\.(ts|tsx|js|mjs)$/.test(filePath)) return violations;
    // Skip vendor, dist, test fixtures, and our own local checks
    if (
      /node_modules|\/dist\/|\/__tests__\/|\/vendor\/|resilience\/|perf\/|persistence\//.test(
        filePath,
      )
    )
      return violations;

    const lines = content.split(/\r?\n/);
    const hasFinally = /\bfinally\s*\{/.test(content);
    const acquirePatterns = [
      /\bnew AbortController\s*\(/,
      /\bsetTimeout\s*\(/,
      /\bsetInterval\s*\(/,
      /\bopen\(|createWriteStream|createReadStream/,
      /\btmpfile|mkdtemp|writeFileSync.*tmp|unlinkSync.*tmp/,
      /\bnew WebSocket|new EventSource|addEventListener\s*\(/,
      /signal\.addEventListener|on\(['"](error|close|abort)/,
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/\/\/\s*resilience-ok\b/.test(line)) continue;

      const looksLikeAcquire = acquirePatterns.some((re) => re.test(line));
      if (!looksLikeAcquire) continue;

      // Naive: if the file has no finally at all, every acquire is suspect.
      // Better heuristic would walk for enclosing try without sibling finally,
      // but a whole-file "no finally + acquire" is already a strong smell for baseline.
      if (!hasFinally) {
        violations.push({
          line: i + 1,
          message: `Acquire of potentially-leaky resource without any finally block in file (AbortController/setTimeout/timer/fs listener etc.). On abort/timeout/error the release may be skipped. Add finally { clearTimeout(...); controller.abort(); ... } or // resilience-ok with justification.`,
          severity: "warning",
        });
      }
    }

    return violations;
  },
};

export default requireFinallyForCleanup;
