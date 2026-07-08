import { defineExternalToolAdapter } from '@opensip-cli/external-tool-adapter';

import type { Tool } from '@opensip-cli/core';

export const tool: Tool = defineExternalToolAdapter({
  identity: { name: 'clean' },
  metadata: {
    id: '00000000-0000-4000-8000-000000000001',
    version: '1.0.0',
    description: 'Clean adapter',
    adapterPackage: '@opensip-cli/tool-clean',
  },
  binary: { command: 'clean', versionArgs: ['--version'], resolution: ['path'] },
  network: 'local-only',
  commands: [],
});
