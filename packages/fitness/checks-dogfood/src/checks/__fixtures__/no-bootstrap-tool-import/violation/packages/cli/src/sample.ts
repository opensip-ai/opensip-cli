// Violation: the CLI host statically imports a tool RUNTIME — re-privileging
// the bundled load path the 3.0.0 cutover removed (§1).
import { fitnessTool } from '@opensip-cli/fitness';
import { graphTool as gt } from '@opensip-cli/graph';

export const tools = [fitnessTool, gt];
