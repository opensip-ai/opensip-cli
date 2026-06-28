/**
 * VIOLATION fixture for `adapter-must-use-substrate`: an adapter that hand-rolls
 * the scanner loop. It imports node:child_process, calls execFile directly, and
 * builds its Tool with raw defineTool instead of defineExternalToolAdapter —
 * three independent signals the check fires on.
 */
import { execFile } from 'node:child_process';
import { defineTool } from '@opensip-cli/core';

import type { Tool } from '@opensip-cli/core';

export const tool: Tool = defineTool({
  identity: { name: 'gitleaks' },
  metadata: {
    id: 'cd08f737-ce8e-4813-9259-b4ffeb954268',
    version: '0.0.0',
    description: 'Secret scanning via Gitleaks',
  },
  commandSpecs: [
    {
      name: 'gitleaks',
      scope: 'project',
      output: 'raw-stream',
      handler: async (_opts, _cli) => {
        // Re-implementing the substrate's subprocess boundary — exactly what the
        // check forbids: the host/substrate must own execFile, not the adapter.
        execFile('gitleaks', ['detect'], () => undefined);
      },
    },
  ],
});
