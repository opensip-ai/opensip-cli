/**
 * External-tool-adapter error definitions (Plan 00 Phase 5 scanner lifecycle).
 */

import { defineErrorCatalog } from '@opensip-cli/core';

export const externalToolErrorCatalog = defineErrorCatalog(
  {
    id: 'external-tool-adapter',
    displayName: 'external-tool-adapter',
    packageName: '@opensip-cli/external-tool-adapter',
  },
  {
    'EXTERNAL.SCANNER.BINARY_MISSING': {
      code: 'EXTERNAL.SCANNER.BINARY_MISSING',
      source: 'external',
      defaultResponsibility: 'operator',
      kind: 'not-found',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'configuration',
      operatorAction:
        'Install the scanner binary, add it to PATH, or set the tool binary path config/env pin.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['tool', 'command', 'layer'],
    },
    'EXTERNAL.SCANNER.SPAWN_FAILED': {
      code: 'EXTERNAL.SCANNER.SPAWN_FAILED',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'I/O',
      retry: 'caller-policy',
      severity: 'error',
      exposure: 'redacted',
      exitClass: 'runtime',
      operatorAction: 'Check binary permissions and OS errno; retry after fixing the environment.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['command', 'errno'],
    },
    'EXTERNAL.SCANNER.KILLED_BY_SIGNAL': {
      code: 'EXTERNAL.SCANNER.KILLED_BY_SIGNAL',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'I/O',
      retry: 'caller-policy',
      severity: 'error',
      exposure: 'redacted',
      exitClass: 'runtime',
      operatorAction:
        'The scanner was killed by an external signal (OOM killer, kill -9, container stop). Check system memory and process limits, then retry.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['command', 'signal'],
    },
  },
  { allowLegacyCodes: true },
);
