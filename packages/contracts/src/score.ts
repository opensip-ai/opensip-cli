/**
 * Canonical pass rate for a run.
 *
 * `score` is a shared field on {@link CliOutput} and `StoredSession` that
 * the dashboard renders as the "PASS RATE" column. It has ONE meaning
 * across every tool: the percentage of checks that passed.
 *
 * A check passes when it has no error-severity findings — warnings alone
 * do not fail a check (see `CheckOutput.passed`). So a warnings-only run
 * scores 100, consistent with the WARN-but-passing status the dashboard
 * shows for it. An empty run (no checks) also scores 100, matching the
 * fitness gate-baseline convention so `--gate-compare` does not report a
 * phantom regression on an empty recipe.
 *
 * This lives in contracts — the layer below every tool — because the
 * formula must be identical everywhere `score` is produced. Each tool
 * previously rolled its own: fitness used passed/total, but graph used a
 * findings-count penalty (`100 - findings`), which disagreed with its own
 * passed/total summary and rendered 0% for warnings-only runs. Route all
 * score computation through here so they cannot drift again.
 */
export function passRate(summary: { readonly total: number; readonly passed: number }): number {
  return summary.total > 0 ? Math.round((summary.passed / summary.total) * 100) : 100;
}
