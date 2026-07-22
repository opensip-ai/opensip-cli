/**
 * lineOfNeedle — shared by `report-producer-open-flag` and
 * `session-persist-requires-replay`: locate the 1-based line number of the
 * first occurrence of `needle` in `content`, for pointing a finding at a
 * stable, human-readable location. Falls back to line 1 when the needle is
 * absent (callers only call this once they already know the needle is
 * present, so the fallback is defensive, not a validity check).
 *
 * Plain helper module — no `checks`/`recipes` export, so while the
 * project-local plugin loader (packages/core/src/plugins/discover.ts)
 * discovers and imports every `.mjs` under `fit/checks/`, it registers
 * nothing from this file (registerFitExports only picks up `Check`
 * instances). Same shape as the existing `tool-engine-paths.mjs` helper,
 * already imported by several check files here without being mis-loaded
 * as a check itself.
 */
export function lineOfNeedle(content, needle) {
  const index = content.indexOf(needle);
  if (index < 0) return 1;
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}
