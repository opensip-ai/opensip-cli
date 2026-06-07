// Clean fixture: reads the tool's own `graph:` block but validates it through a
// Zod schema before projecting — the compliant ADR-0023 path. 0 findings.
export function loadGraphConfig(filePath: string): unknown {
  const doc = readYamlFile(filePath) as Record<string, unknown>
  const graphBlock = doc.graph
  const parsed = GraphConfigSchema.strict().safeParse(graphBlock)
  if (!parsed.success) return {}
  return parsed.data
}

// And the ADR-0022 recipe-NAME resolver: reads the own block but ONLY `.recipe`,
// which is exempt (a single scalar for cross-tool recipe precedence).
export function resolveGraphRecipe(filePath: string): string | undefined {
  const doc = readYamlFile(filePath) as Record<string, unknown>
  const block = doc.graph as Record<string, unknown>
  return typeof block.recipe === 'string' ? block.recipe : undefined
}

declare function readYamlFile(p: string): unknown
declare const GraphConfigSchema: {
  strict(): { safeParse(v: unknown): { success: boolean; data: unknown } }
}
