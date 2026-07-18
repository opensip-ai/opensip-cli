/**
 * template — render the document-level skeleton of `opensip-cli.config.yml`
 * that `opensip init` scaffolds.
 *
 * The config package owns the *document shape*, so it owns the rendering of the
 * host-owned blocks — `schemaVersion`, `globalExcludes`, and `targets` — that it
 * also validates (the host declarations in {@link ./host-declarations}). This
 * removes the second, hand-written definition of the document shape that used to
 * live in the CLI's init templates and could drift from what the composed schema
 * accepts (ADR-0023).
 *
 * The CLI composition root supplies starter *content* (the full global-exclude
 * list, per-language target templates, language order) via
 * {@link DocumentHeaderInput}. This package stays generic: it renders whatever
 * excludes/targets the caller provides. The small library default below is only
 * a fallback for other consumers that omit `globalExcludes` — it is not the
 * product starter set (that lives in the CLI's `starter-config` model so cache
 * and Init share one host-owned semantics).
 *
 * Per-tool blocks (e.g. `fitness:`) remain Tool-owned and are appended by the
 * CLI after this header. A round-trip test (`renderDocumentHeader` output
 * parses clean through the composed schema) guarantees the skeleton never
 * drifts from validation.
 */

/** One named target as the template should scaffold it. */
export interface TargetTemplateInput {
  readonly name: string;
  readonly description: string;
  readonly languages: readonly string[];
  readonly concerns?: readonly string[];
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

/** Inputs for the document-level skeleton. */
export interface DocumentHeaderInput {
  /** The schema version to stamp (the CLI's supported version). */
  readonly schemaVersion: number;
  /** The named targets to scaffold (the CLI provides per-language content). */
  readonly targets: readonly TargetTemplateInput[];
  /**
   * Global exclude globs. When omitted, {@link DEFAULT_GLOBAL_EXCLUDES} is used
   * as a small library fallback — product starter semantics pass the full list
   * explicitly from the CLI composition root.
   */
  readonly globalExcludes?: readonly string[];
}

/**
 * Small library default when callers omit `globalExcludes`. Not the product
 * starter set; the CLI host supplies the full starter list for cache/Init.
 */
const DEFAULT_GLOBAL_EXCLUDES: readonly string[] = ['**/node_modules/**', '**/dist/**'];

/** Render one target into the `targets:` block, matching `targetsRecordSchema`. */
function renderTarget(t: TargetTemplateInput): string[] {
  const concerns = t.concerns ?? ['backend'];
  return [
    `  ${t.name}:`,
    `    description: ${t.description}`,
    `    languages: [${t.languages.join(', ')}]`,
    `    concerns: [${concerns.join(', ')}]`,
    '    include:',
    ...t.include.map((p) => `      - "${p}"`),
    '    exclude:',
    ...t.exclude.map((p) => `      - "${p}"`),
    '',
  ];
}

/**
 * Render the host-owned document skeleton: the header comment, `schemaVersion`,
 * `globalExcludes`, and the `targets` block. The result is valid YAML that
 * parses clean through the composed whole-document schema (the host
 * declarations). The CLI appends tool blocks (e.g. `fitness:`) after this.
 */
export function renderDocumentHeader(input: DocumentHeaderInput): string {
  const globalExcludes = input.globalExcludes ?? DEFAULT_GLOBAL_EXCLUDES;
  const lines: string[] = [
    '# OpenSIP CLI — project configuration',
    '#',
    '# Defines named target file sets for fitness checks. Each fitness',
    '# check declares a `scope` (languages + concerns); discovery',
    '# matches it against these targets to determine which files the',
    '# check runs against.',
    '#',
    '# Docs: https://github.com/opensip-ai/opensip-cli#configuration',
    '',
    `schemaVersion: ${input.schemaVersion}`,
    '',
    'globalExcludes:',
    ...globalExcludes.map((p) => `  - "${p}"`),
    '',
    'targets:',
  ];
  for (const t of input.targets) lines.push(...renderTarget(t));
  return lines.join('\n');
}
