// Violation fixture: a reintroduced `projectGraphConfig`-style hand-projection.
// Reads the tool's own `graph:` block and projects MULTIPLE knobs out of it with
// NO Zod parse — the exact drift ADR-0023 paid down. Must flag.
export function projectGraphConfig(filePath: string): unknown {
  const doc = readYamlFile(filePath) as Record<string, unknown>
  const block = doc.graph as Record<string, unknown>
  return {
    minDuplicateBodyLines:
      typeof block.minDuplicateBodyLines === 'number' ? block.minDuplicateBodyLines : undefined,
    cycleMinSize: typeof block.cycleMinSize === 'number' ? block.cycleMinSize : undefined,
  }
}

declare function readYamlFile(p: string): unknown
