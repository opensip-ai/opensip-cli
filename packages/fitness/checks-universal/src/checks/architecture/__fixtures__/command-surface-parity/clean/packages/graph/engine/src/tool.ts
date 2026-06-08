// CLEAN: the tool declares a `commandSpecs` surface and never touches Commander.
// The host mounts each spec via mountCommandSpec (release 2.11.0 command plane).
import { graphCommandSpecs } from './commands/index.js'

export const graphTool = {
  metadata: { id: 'graph', description: 'Static call-graph analysis' },
  commands: [GRAPH, GRAPH_LOOKUP],
  // Declared command surface — no register() body, no raw program access.
  commandSpecs: graphCommandSpecs,
  contributeScope,
}
