/**
 * @fileoverview Shared helper for the two config-document architecture checks
 * (`one-config-document`, `no-config-loader-outside-config`).
 *
 * Both checks must first identify which local identifiers in a file are bound to
 * a parsed YAML document — only a namespace/block read OFF one of those counts
 * as a config hand-projection; a read off a request object, `scope`, etc. is
 * unrelated and ignored. The detection was byte-identical in both files (it
 * tripped the graph `duplicated-function-body` rule), so it lives here once.
 *
 * Underscore-prefixed and absent from the check barrel (`index.ts`): this is an
 * internal helper, not a `defineCheck` export.
 */

/**
 * Identifiers bound to a parsed YAML document in this file — the result of a
 * `const <id> = readYamlFile(...)` (or a sibling reader: `readYamlFileOrThrow`,
 * `parseYaml`, `loadYaml`).
 *
 * @param content - the source text of the file under analysis.
 * @returns the set of local binding names that hold a parsed YAML document.
 */
export function yamlDocBindings(content: string): Set<string> {
  const docs = new Set<string>()
  const re =
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:readYamlFile|readYamlFileOrThrow|parseYaml|loadYaml)\s*\(/g
  for (const m of content.matchAll(re)) docs.add(m[1])
  return docs
}
