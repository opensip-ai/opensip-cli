/**
 * @fileoverview no-config-loader-outside-config — a package other than
 *               `@opensip-cli/config` may not hand-roll a loader for a
 *               tool-AGNOSTIC, document-level block of `opensip-cli.config.yml`.
 *               Project-local SELF-check.
 *
 * Relocated out of `@opensip-cli/checks-*` because it encodes opensip-cli local
 * facts: it hardcodes the first-party config-reading paths by package
 * (`packages/{cli,fitness,graph,simulation}/(engine/)?src/`), the tool-agnostic
 * document-level block keys owned by `@opensip-cli/config`
 * (`cli`/`targets`/`globalExcludes`/`checkOverrides`/`dashboard`), and cites the
 * config-consolidation release 2.10.1 / ADR-0023 (Phase 4, north-star
 * Principle 6). A consumer repo has none of those packages or blocks, so the
 * rule is opensip-internal, not universal. Inert for adopters per
 * `opensip-cli/fit/checks/README.md`.
 *
 * WHY: The config-consolidation release moved the scattered hand-projections
 * (`contracts/cli-config.ts`'s `projectCliDefaults`, fitness's targeting
 * loaders' inline schemas) into `@opensip-cli/config`, behind one composed
 * whole-document validation. This guardrail keeps the next release from
 * re-accumulating that drift: it fires when a file OUTSIDE the config package
 * binds a parsed YAML document and reads a document-level block off it, then
 * projects fields out of that block WITHOUT routing it through a Zod parse.
 *
 * COMPLEMENT TO `one-config-document` — that check governs a TOOL reading its
 * OWN namespace block (`graph`/`fitness`/`simulation`); this one governs the
 * tool-AGNOSTIC document blocks. Together they make "config is parsed only in
 * `@opensip-cli/config`" mechanically true.
 *
 * NOT flagged (the compliant tree): a binding handed into a Zod `.parse(...)` /
 * `.safeParse(...)` (e.g. fitness's `loadTargetsConfig` / `loadSignalersConfig`,
 * which read the document THROUGH the config-owned schemas to build their
 * runtime registry) — schema-routed reads are exactly the allowed path.
 *
 * SCOPE — opensip-cli' own first-party config-reading paths (cli bootstrap +
 * the tool engines). The path guard makes the check inert in adopter repos and
 * exempts the config package itself (the one allowed home).
 *
 * The shared `yamlDocBindings` helper (an internal sibling of the original
 * shipped check) is inlined below — this self-check is self-contained.
 *
 * `raw` content: the block keys + field projections are code member-accesses,
 * not strings; the binding regex keys off `const x = <yamlDoc>.<key>`.
 */
import { defineCheck } from '@opensip-cli/fitness';

/** First-party paths that read the opensip-cli config document (config pkg excluded). */
const CONFIG_READER_PATH = /packages\/(?:cli|fitness|graph|simulation)\/(?:engine\/)?src\//;

/** The tool-agnostic, document-level blocks owned by @opensip-cli/config. */
const DOCUMENT_LEVEL_KEYS = ['cli', 'targets', 'globalExcludes', 'checkOverrides', 'dashboard'];

/**
 * Identifiers bound to a parsed YAML document in this file — the result of a
 * `const <id> = readYamlFile(...)` (or a sibling reader: `readYamlFileOrThrow`,
 * `parseYaml`, `loadYaml`). Inlined from the original shipped check's internal
 * `_yaml-doc-bindings.ts` helper so this self-check stands alone.
 */
function yamlDocBindings(content) {
  const docs = new Set();
  const re =
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:readYamlFile|readYamlFileOrThrow|parseYaml|loadYaml)\s*\(/g;
  for (const m of content.matchAll(re)) docs.add(m[1]);
  return docs;
}

/**
 * Find `const <local> = <yamlDoc>.<docKey>` bindings (docKey a document-level
 * block), collect the fields projected off each, and whether each is handed
 * into a Zod parse. A binding that IS parsed is compliant.
 */
function documentBlockBindings(content) {
  const bindings = new Map();
  const docs = yamlDocBindings(content);
  if (docs.size === 0) return bindings;
  const docAlt = [...docs].map((d) => d.replaceAll('$', String.raw`\$`)).join('|');
  const keyAlt = DOCUMENT_LEVEL_KEYS.join('|');
  const bindRe = new RegExp(
    String.raw`(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:${docAlt})(?:\?)?\.(${keyAlt})\b`,
    'g',
  );
  for (const m of content.matchAll(bindRe)) {
    bindings.set(m[1], { key: m[2], fields: new Set(), parsed: false });
  }
  for (const [binding, info] of bindings) {
    const fieldRe = new RegExp(String.raw`\b${binding}\.([A-Za-z_$][\w$]*)\b`, 'g');
    for (const fm of content.matchAll(fieldRe)) info.fields.add(fm[1]);
    const parseRe = new RegExp(String.raw`\.(?:safeParse|parse)\s*\(\s*${binding}\b`);
    info.parsed = parseRe.test(content);
  }
  return bindings;
}

/**
 * Pure analysis over one source file. Returns a finding when the file
 * hand-projects a document-level config block out of a parsed YAML document
 * WITHOUT a Zod parse. Exported for unit tests.
 */
export function analyzeNoConfigLoaderOutsideConfig(content, filePath) {
  if (!CONFIG_READER_PATH.test(filePath)) return [];
  const bindings = documentBlockBindings(content);
  if (bindings.size === 0) return [];

  const violations = [];
  for (const info of bindings.values()) {
    // A binding routed through a Zod parse is the allowed schema-routed read.
    if (info.parsed) continue;
    if (info.fields.size === 0) continue;
    const readList = [...info.fields].map((f) => `'${f}'`).join(', ');
    violations.push({
      line: 1,
      filePath,
      message:
        `Hand-rolled loader for the document-level '${info.key}:' block of ` +
        `opensip-cli.config.yml (projects ${readList}) outside ` +
        `@opensip-cli/config. The tool-agnostic document blocks (cli/targets/` +
        `globalExcludes/checkOverrides/dashboard) are owned, schema'd, and ` +
        `strict-validated by @opensip-cli/config (ADR-0023).`,
      severity: 'error',
      suggestion:
        `Read the '${info.key}:' block through @opensip-cli/config (its schema / ` +
        `loader, or off the composed scope config) instead of projecting raw YAML ` +
        `fields. Schema-routed reads (a binding handed to .parse/.safeParse) are ` +
        `the allowed path; a fresh hand-projection re-introduces the drift 2.10.1 removed.`,
      type: 'no-config-loader-outside-config',
    });
  }
  return violations;
}

/**
 * Walk every scanned file and run {@link analyzeNoConfigLoaderOutsideConfig}.
 * Exported so unit tests can drive it with an in-memory `FileAccessor`.
 */
export async function analyzeAllNoConfigLoaderOutsideConfig(files) {
  const violations = [];
  const candidates = files.paths.filter((p) => CONFIG_READER_PATH.test(p) && p.endsWith('.ts'));
  const contents = await files.readMany(candidates);
  for (const [filePath, content] of contents) {
    violations.push(...analyzeNoConfigLoaderOutsideConfig(content, filePath));
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: '1e8a6367-e2f2-4acf-ac85-a85bb0e46955',
    slug: 'no-config-loader-outside-config',
    description:
      'A tool-agnostic config block (cli/targets/globalExcludes/checkOverrides/dashboard) must be parsed only in @opensip-cli/config, not hand-rolled elsewhere (ADR-0023)',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture'],
    fileTypes: ['ts'],
    // raw content: the block keys + field projections are code member-accesses,
    // not strings; the binding regex keys off `const x = <yamlDoc>.<key>`.
    contentFilter: 'raw',
    analyzeAll: analyzeAllNoConfigLoaderOutsideConfig,
  }),
];
