/**
 * @fileoverview tool-command-taxonomy — first-party tool commands follow the
 *               Tier-2 taxonomy grammar (verb shape, export-under-tool,
 *               internal-marker). Project-local SELF-check.
 *
 * Companion to `command-surface-parity.mjs`: where that check forbids raw-Commander
 * reach-back from a tool registration file, THIS check validates the SHAPE of the
 * command names a tool declares — the Tier-2 `<tool> <verb> [object]` grammar from
 * the tool-command-surface-taxonomy spec. It is the dogfood-gate complement to the
 * behaviour-parity snapshot (which pins the full runtime tree): this check asserts
 * grammar shape on the *declared command names* it can read from the
 * `ToolCommandDescriptor` object literals, not full runtime parity.
 *
 * SCOPE — opensip-cli' own first-party TOOL registration files only
 * (`packages/{fitness,graph,simulation}/engine/src/tool.ts`, the exact path
 * fragment `command-surface-parity.mjs` uses). The path guard makes it inert in
 * adopter repos (whose tools declare arbitrary command names). Because the
 * descriptors are TypeScript object literals (not a runtime registry a `.mjs`
 * check can import), this operates on file TEXT — it parses the `name:` literals
 * inside `ToolCommandDescriptor` declarations and the `visibility` / `parent`
 * markers in the same literal, exactly the way `command-surface-parity.mjs`
 * text-scans the same files.
 *
 * ── RULES ────────────────────────────────────────────────────────────────────
 * The legacy flat-root aliases were removed once their deprecation window closed,
 * so the only command surface a first-party `tool.ts` declares is the bare tool
 * verb, the internal workers, and the nested `<tool> <verb>` children. The three
 * rules:
 *
 * - **Rule A (no masquerading export verb)** flags a bare `*-export` descriptor
 *   (`catalog-export` / `sarif-export`) ONLY when the same file ALSO declares a
 *   canonical `export` descriptor (`name: 'export'`). The canonical `graph export`
 *   / `fit export` command exists today, so this rule forbids re-introducing a
 *   bare top-level export verb alongside it — the export surface must be the
 *   nested `<tool> export` form.
 *
 * - **Rule B (internal commands carry the marker)** flags a worker/equivalence
 *   descriptor (`*-run-worker`, `*-shard-worker`, `graph-equivalence-check`) that
 *   does NOT declare `visibility: 'internal'` ONLY when the same file ALSO
 *   demonstrates the marker convention is in use (at least one descriptor in the
 *   file declares `visibility: 'internal'`). The workers carry the marker today,
 *   so this rule catches any new worker that forgets it.
 *
 * - **Rule C (verb shape)** is always active (warning-level): every public
 *   descriptor name must be the bare tool verb, a tool-prefixed grouped name, a
 *   `parent`-nested child, or an internal worker name.
 *
 * `raw` content: the tokens we read (`name:`, `visibility:`, `ToolCommandDescriptor`)
 * are code, and the path guard restricts us to tool.ts files, so prose cannot
 * false-fire. Stripping comments is unnecessary.
 */
import { defineCheck } from '@opensip-cli/fitness';

/** Resolved-path fragment identifying a first-party TOOL registration file. */
const TOOL_REGISTRATION_PATH = /packages\/(?:fitness|graph|simulation)\/engine\/src\/tool\.ts$/;

/**
 * The expected bare command verb per first-party tool file (Q1: the SHORT verb
 * is `metadata.name` AND the primary command name). `fitness`→`fit`,
 * `graph`→`graph`, `simulation`→`sim`. Keyed by the package segment in the path.
 */
const TOOL_VERB = {
  fitness: 'fit',
  graph: 'graph',
  simulation: 'sim',
};

/** Internal worker/equivalence command-name shapes (Tier-3). */
const INTERNAL_NAME_RE = /-(?:run-worker|shard-worker)$/;
const GRAPH_EQUIVALENCE = 'graph-equivalence-check';

/** Bare masquerading export verbs (no tool prefix) — the T-2 target. */
const MASQUERADING_EXPORT_RE = /^(?:sarif|catalog)-export$/;

/** Which package segment (fitness|graph|simulation) does this path belong to? */
function packageSegment(filePath) {
  const m = /packages\/(fitness|graph|simulation)\/engine\/src\/tool\.ts$/.exec(filePath);
  return m ? m[1] : undefined;
}

/**
 * Extract every `ToolCommandDescriptor` object literal from the file text. Each
 * descriptor is a `const NAME: ToolCommandDescriptor = { ... };` block; we slice
 * from the `{` to the line-anchored closing `};`. Returns one record per
 * descriptor with its declared `name`, its 1-based source line, and whether the
 * SAME literal declares `visibility: 'internal'` / a `parent`. We parse only
 * `ToolCommandDescriptor` literals so the tool's `metadata.name` block (e.g.
 * `name: 'fitness'`) is never mistaken for a command name.
 */
function extractDescriptors(content) {
  const descriptors = [];
  const lines = content.split('\n');
  // Match the start of a descriptor declaration: `... : ToolCommandDescriptor = {`
  const declRe = /:\s*ToolCommandDescriptor\s*=\s*\{/;

  for (let i = 0; i < lines.length; i++) {
    if (!declRe.test(lines[i])) continue;
    const startLine = i;
    // Collect the literal body until the line-anchored closing `};`.
    const body = [lines[i]];
    let end = i;
    for (let j = i; j < lines.length; j++) {
      if (j !== i) body.push(lines[j]);
      if (/^\s*\};/.test(lines[j])) {
        end = j;
        break;
      }
    }
    const block = body.join('\n');
    const nameMatch = /\bname:\s*'([^']+)'/.exec(block);
    if (nameMatch) {
      descriptors.push({
        name: nameMatch[1],
        line: startLine + 1,
        internal: /\bvisibility:\s*'internal'/.test(block),
        parent: /\bparent:\s*'([^']+)'/.exec(block)?.[1],
      });
    }
    i = end; // resume after this literal
  }
  return descriptors;
}

/**
 * Pure analysis. Exported so unit tests can exercise the three rules directly.
 * Returns `[]` for any file outside the first-party tool-registration scope.
 */
export function analyzeToolCommandTaxonomy(content, filePath) {
  if (!TOOL_REGISTRATION_PATH.test(filePath)) return [];

  const segment = packageSegment(filePath);
  const verb = segment ? TOOL_VERB[segment] : undefined;
  const descriptors = extractDescriptors(content);
  const violations = [];

  // Activation gates (see file header — two-stage activation keeps Phase 0 green):
  const hasCanonicalExport = descriptors.some((d) => d.name === 'export');
  const markerConventionInUse = descriptors.some((d) => d.internal);

  for (const d of descriptors) {
    const isInternalName = INTERNAL_NAME_RE.test(d.name) || d.name === GRAPH_EQUIVALENCE;

    // Rule A — no masquerading export verb (activates once a canonical `export`
    // command exists in this file; see header). The legacy flat-root export
    // aliases were removed, so a bare `*-export` verb alongside the canonical
    // `export` is always a regression to forbid.
    if (hasCanonicalExport && MASQUERADING_EXPORT_RE.test(d.name)) {
      violations.push({
        message: `Export command '${d.name}' is a bare top-level verb; it must live under its tool ('${verb} export --format sarif|catalog'), not masquerade as a platform-level command.`,
        severity: 'error',
        line: d.line,
        suggestion: `Make '${verb} export' the canonical command (declare 'export' with parent: '${verb}') instead of a bare flat verb.`,
      });
      continue;
    }

    // Rule B — internal workers must declare the visibility marker (activates
    // once the marker convention is in use in this file; see header).
    if (isInternalName) {
      if (markerConventionInUse && !d.internal) {
        violations.push({
          message: `Internal worker command '${d.name}' must declare visibility: 'internal' so the host hides it from --help, completion, and the agent-catalog.`,
          severity: 'error',
          line: d.line,
          suggestion:
            "Add `visibility: 'internal'` to this ToolCommandDescriptor (Tier-3 — invocable but hidden).",
        });
      }
      continue; // internal names are exempt from the public verb-shape rule
    }

    // Rule C — verb shape (always active). A public descriptor name must be the
    // bare tool verb, a tool-prefixed grouped name (`<verb>-...`), or a `parent`-
    // nested child (`graph export` IS the grammar, by construction). Anything
    // else does not fit the `<tool> <verb> [object]` grammar and is flagged
    // (warning — shape guidance, not a hard gate).
    const isBareVerb = d.name === verb;
    const isToolPrefixed = verb !== undefined && d.name.startsWith(`${verb}-`);
    const isNested = d.parent !== undefined;
    if (!isBareVerb && !isToolPrefixed && !isNested) {
      violations.push({
        message: `Command '${d.name}' does not fit the Tier-2 grammar: a public ${segment ?? 'tool'} command should be the bare verb '${verb}' or a tool-grouped form ('${verb} <object>' / nested via parent: '${verb}').`,
        severity: 'warning',
        line: d.line,
        suggestion: `Express it as '${verb} <verb> [object]' — declare it with parent: '${verb}' so it mounts under the tool, or mark it internal if it is a worker.`,
      });
    }
  }

  return violations;
}

export const checks = [
  defineCheck({
    id: 'b202032b-9c00-4d4e-85fb-0c024bb48c1a',
    slug: 'tool-command-taxonomy',
    description:
      'First-party tool commands follow the Tier-2 taxonomy grammar (verb shape, export-under-tool, internal-marker)',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture'],
    fileTypes: ['ts'],
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeToolCommandTaxonomy(content, filePath),
  }),
];
