/**
 * @fileoverview one-config-document — a tool may not hand-project its own config
 *               block out of `opensip-cli.config.yml`; it must validate through a
 *               Zod schema the host composes into ONE whole-document validation
 *               (release 2.10.0, ADR-0023, Phase 4 / north-star Principle 6).
 *               Project-local SELF-check.
 *
 * Lives here (not in the shipped `@opensip-cli/checks-*` packs) because it encodes
 * opensip-cli local facts: it self-targets opensip-cli' OWN tool-engine sources by
 * first-party path (`packages/{fitness,graph,simulation}/engine/src/**`), keys on
 * the per-tool config namespaces (`graph` / `fitness` / `simulation`) and on
 * opensip-cli' own `ToolConfigDeclaration` + composed-Zod-validation seam
 * (ADR-0023, ADR-0022 recipe-NAME precedence). The tool-engine path guard makes
 * the check inert in adopter repos (whose code never matches those paths) — it
 * enforces THIS platform's architecture, not a universal rule. Inert for adopters
 * per `opensip-cli/fit/checks/README.md`.
 *
 * WHY: The capability-configuration release replaced graph's hand-rolled
 * `projectGraphConfig` (a permissive YAML-object projection over the `graph:`
 * block that silently dropped typos) with `graphConfigDeclaration` — a namespaced
 * `ToolConfigDeclaration` the host composes + STRICT-validates before dispatch.
 * fitness and sim do the same. This guardrail is the definition of done that keeps
 * the next release from re-accumulating that drift: it fires when a first-party
 * tool-engine file reads its OWN config namespace block from a parsed YAML
 * document and projects MULTIPLE knob fields out of it WITHOUT routing the block
 * through a Zod parse.
 *
 * SELF-TARGETING — the check inspects opensip-cli' own tool-engine sources. For
 * each such file it first finds the identifiers bound to a PARSED YAML DOCUMENT
 * (`const doc = readYamlFile(...)` and siblings), then a read of the tool's own
 * namespace key OFF one of those document bindings (`<doc>.graph`, `<doc>.fitness`,
 * `<doc>.simulation`) bound to a local, then the fields projected off that
 * binding. Anchoring on a yaml-doc source means an unrelated `.graph` member read
 * (e.g. `scope.graph?.rules`) is ignored. A binding that is NOT handed into a Zod
 * parse (`<binding>` inside a `.parse(...)` / `.safeParse(...)` argument) and
 * projects a non-`recipe` field is an unvalidated hand-projection and is flagged.
 *
 * NARROWING — ONE deliberate exemption keeps this at 0 findings on the compliant
 * tree:
 *   1. A block projection that reads ONLY the `recipe` key is the ADR-0022
 *      recipe-NAME resolver (`resolveGraphRecipeSelection` /
 *      `resolveSimRecipeSelection`), which reads a single scalar for cross-tool
 *      recipe precedence — not a config hand-projection. A binding whose only
 *      own-namespace field access is `.recipe` is exempt.
 *
 * The former 2.10.1-deferral carve-out is gone: in Phase 4 the tools read their
 * OWN resolved namespace off `scope.toolConfig.<ns>` (no own-namespace YAML
 * projection survives), and the cli/targeting/global loaders read OTHER top-level
 * blocks (`cli:`, `targets:`, `globalExcludes:`) governed by the sibling
 * `no-config-loader-outside-config` check — so they never match the own-namespace
 * read anchor here regardless.
 *
 * `raw` content: the namespace keys + field projections we detect are code
 * member-accesses, not strings; the binding regex keys off `const x = y.<ns>`, so
 * prose mentioning a namespace cannot false-fire.
 */
import { defineCheck } from '@opensip-cli/fitness';

import { toolEnginePathRe, toolPackageSegmentForPath } from './tool-engine-paths.mjs';

/** Resolved-path fragment identifying a first-party tool-engine source file. */
const TOOL_ENGINE_PATH = toolEnginePathRe();

/** Maps an engine namespace directory to its config-document top-level key. */
const NAMESPACE_BY_DIR = {
  fitness: 'fitness',
  graph: 'graph',
  simulation: 'simulation',
};

/** The recipe-name key — an own-namespace read of ONLY this is exempt (ADR-0022). */
const RECIPE_KEY = 'recipe';

/**
 * Identifiers bound to a parsed YAML document in this file — the result of a
 * `const <id> = readYamlFile(...)` (or a sibling reader: `readYamlFileOrThrow`,
 * `parseYaml`, `loadYaml`). Inlined from the pack-internal `_yaml-doc-bindings`
 * helper shared by `one-config-document` + `no-config-loader-outside-config`.
 */
function yamlDocBindings(content) {
  const docs = new Set();
  const re =
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:readYamlFile|readYamlFileOrThrow|parseYaml|loadYaml)\s*\(/g;
  for (const m of content.matchAll(re)) docs.add(m[1]);
  return docs;
}

/**
 * Find the local identifier(s) a file binds the tool's own namespace block to,
 * by scanning for `const <id> = <yamlDoc>.<namespace>` assignments where
 * `<yamlDoc>` is a parsed-YAML-document binding, then collect (a) the fields
 * projected off each binding and (b) whether the binding is handed into a Zod
 * parse. A binding that IS parsed, or projects only `recipe`, is compliant.
 */
function bindingsForNamespace(content, namespace) {
  const bindings = new Map();
  const docs = yamlDocBindings(content);
  if (docs.size === 0) return bindings;
  // `const block = doc.graph` / `const graphBlock = document.graph` etc. The
  // RHS object MUST be a parsed-YAML-document binding AND the key MUST be the
  // tool's OWN namespace (not `cli`, `targets`, `signalers`, …). Anchoring on a
  // yaml-doc source rejects `scope.graph?.rules` and other unrelated `.graph`
  // member reads.
  const docAlternation = [...docs].map((d) => d.replaceAll('$', String.raw`\$`)).join('|');
  const bindRe = new RegExp(
    String.raw`(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:${docAlternation})\.${namespace}\b`,
    'g',
  );
  for (const m of content.matchAll(bindRe)) {
    bindings.set(m[1], { fields: new Set(), parsed: false });
  }
  if (bindings.size === 0) return bindings;
  for (const [binding, info] of bindings) {
    // Fields projected off the binding: `block.minDuplicateBodyLines`, `block.recipe`, …
    const fieldRe = new RegExp(String.raw`\b${binding}\.([A-Za-z_$][\w$]*)\b`, 'g');
    for (const fm of content.matchAll(fieldRe)) {
      info.fields.add(fm[1]);
    }
    // Binding handed into a Zod parse: `…parse(block)` / `…safeParse(graphBlock)`.
    // Scoped to THIS binding so a sibling hand-projection in the same file
    // (that happens to also parse a different block) is still caught.
    const parseRe = new RegExp(String.raw`\.(?:safeParse|parse)\s*\(\s*${binding}\b`);
    info.parsed = parseRe.test(content);
  }
  return bindings;
}

/**
 * Pure analysis over one tool-engine source file. Returns a finding when the
 * file hand-projects its own config namespace block (multiple fields, or any
 * non-`recipe` field) out of a parsed YAML document WITHOUT a Zod parse.
 * Exported for unit tests so the detector runs without the Check framework.
 */
export function analyzeOneConfigDocument(content, filePath) {
  if (!TOOL_ENGINE_PATH.test(filePath)) return [];
  const segment = toolPackageSegmentForPath(filePath);
  const namespace = segment === undefined ? undefined : NAMESPACE_BY_DIR[segment];
  if (namespace === undefined) return [];

  const bindings = bindingsForNamespace(content, namespace);
  if (bindings.size === 0) return [];

  const violations = [];
  for (const info of bindings.values()) {
    // A binding routed through a Zod parse is compliant regardless of how many
    // fields it then reads off `parsed.data`.
    if (info.parsed) continue;
    // Exempt the ADR-0022 recipe-NAME resolver: an own-namespace block whose
    // ONLY projected field is `recipe` reads a single scalar for cross-tool
    // recipe precedence — not a config hand-projection.
    const nonRecipe = [...info.fields].filter((f) => f !== RECIPE_KEY);
    if (nonRecipe.length === 0) continue;
    const readList = nonRecipe.map((f) => `'${f}'`).join(', ');
    violations.push({
      line: 1,
      filePath,
      message:
        `Tool '${namespace}' hand-projects its own config block out of ` +
        `opensip-cli.config.yml (reads ${readList}) ` +
        `without a Zod parse. A tool's config block must validate through its ` +
        `namespaced ToolConfigDeclaration so the host composes + strict-validates ` +
        `the whole document before dispatch (ADR-0023).`,
      severity: 'error',
      suggestion:
        `Read the '${namespace}:' block through the tool's Zod schema ` +
        `(e.g. <Namespace>ConfigSchema.strict().safeParse(block)) — the same schema ` +
        `the tool contributes as its ToolConfigDeclaration — instead of projecting ` +
        `raw YAML fields. The composed dispatch-level validation is the strict ` +
        `typo gate (ADR-0023, Phase 4).`,
      type: 'one-config-document',
    });
  }
  return violations;
}

/**
 * Walk every file in the scanned set and run {@link analyzeOneConfigDocument}
 * over each tool-engine source. Non-engine files contribute nothing.
 * Exported so unit tests can drive it with an in-memory `FileAccessor`.
 */
export async function analyzeAllOneConfigDocument(files) {
  const violations = [];
  const candidates = files.paths.filter((p) => TOOL_ENGINE_PATH.test(p) && p.endsWith('.ts'));
  const contents = await files.readMany(candidates);
  for (const [filePath, content] of contents) {
    violations.push(...analyzeOneConfigDocument(content, filePath));
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: 'd86854d1-bcc0-4aca-9d8c-0d621f193355',
    slug: 'one-config-document',
    description:
      'A tool must validate its config block through a composed Zod schema, not hand-project its own opensip-cli.config.yml namespace (ADR-0023)',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture'],
    fileTypes: ['ts'],
    // raw content: the namespace keys + field projections we detect are code
    // member-accesses, not strings; the binding regex keys off `const x = y.<ns>`,
    // so prose mentioning a namespace cannot false-fire.
    contentFilter: 'raw',
    analyzeAll: analyzeAllOneConfigDocument,
  }),
];
