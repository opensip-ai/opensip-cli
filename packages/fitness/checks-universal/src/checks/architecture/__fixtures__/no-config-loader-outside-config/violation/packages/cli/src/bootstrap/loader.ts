// VIOLATION: hand-rolls a loader for the document-level `targets:` block outside
// @opensip-tools/config — binds the parsed YAML doc and projects fields off the
// block WITHOUT routing it through a Zod parse. Should be flagged.
export function loadTargets(configPath: string) {
  const doc = readYamlFile(configPath)
  const targets = doc.targets
  const names = Object.keys(targets)
  const backend = targets.backend
  return { names, backend }
}
