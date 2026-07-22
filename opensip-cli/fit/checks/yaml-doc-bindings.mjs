/**
 * yamlDocBindings — shared by `no-config-loader-outside-config` and
 * `one-config-document`: find identifiers bound to a parsed YAML document in
 * `content` — the result of a `const <id> = readYamlFile(...)` (or a sibling
 * reader: `readYamlFileOrThrow`, `parseYaml`, `loadYaml`). Both checks anchor
 * their own-namespace / document-level-block detection on these bindings so
 * an unrelated `.graph`/`.cli` member read elsewhere in the file can't
 * false-fire.
 *
 * Plain helper module — no `checks`/`recipes` export, so while the
 * project-local plugin loader (packages/core/src/plugins/discover.ts)
 * discovers and imports every `.mjs` under `fit/checks/`, it registers
 * nothing from this file (registerFitExports only picks up `Check`
 * instances). Same shape as the existing `tool-engine-paths.mjs` helper,
 * already imported by several check files here without being mis-loaded
 * as a check itself.
 */
export function yamlDocBindings(content) {
  const docs = new Set();
  const re =
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:readYamlFile|readYamlFileOrThrow|parseYaml|loadYaml)\s*\(/g;
  for (const m of content.matchAll(re)) docs.add(m[1]);
  return docs;
}
