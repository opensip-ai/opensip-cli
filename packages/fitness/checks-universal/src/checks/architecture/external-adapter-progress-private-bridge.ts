/**
 * @fileoverview External-adapter progress bridge privacy.
 *
 * ADR-0139/ADR-0090/ADR-0054 keep installed adapter runtime code isolated in a
 * worker. The host-owned live view needs a narrow progress bridge, but that
 * bridge is private to the CLI worker shim and the external-tool-adapter
 * substrate. This check prevents other packages from importing the private
 * progress symbol or helper functions and turning them into a de facto public
 * ToolCliContext seam.
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

const PRIVATE_PROGRESS_NAMES = [
  'EXTERNAL_ADAPTER_PROGRESS',
  'attachExternalAdapterProgress',
  'externalAdapterProgressOf',
] as const;

const ALLOWED_PATH = /(?:^|\/)packages\/(?:cli|external-tool-adapter)\//;
const NON_SOURCE = /(?:\.test\.tsx?$|\/__tests__\/)/;

function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function importsPrivateProgressBridge(content: string): boolean {
  if (!content.includes('@opensip-cli/external-tool-adapter')) return false;
  return PRIVATE_PROGRESS_NAMES.some((name) => new RegExp(`\\b${name}\\b`).test(content));
}

export function analyzeExternalAdapterProgressPrivateBridge(
  content: string,
  filePath: string,
): CheckViolation[] {
  const normalized = normalizePath(filePath);
  if (NON_SOURCE.test(normalized) || ALLOWED_PATH.test(normalized)) return [];
  if (!importsPrivateProgressBridge(content)) return [];

  return [
    {
      line: 1,
      filePath,
      message:
        'External adapter progress bridge helpers are private to packages/cli and ' +
        'packages/external-tool-adapter. Do not import EXTERNAL_ADAPTER_PROGRESS, ' +
        'attachExternalAdapterProgress, or externalAdapterProgressOf from other packages.',
      severity: 'error',
      suggestion:
        'Route scanner progress through defineExternalToolAdapter and the host worker dispatch; ' +
        'do not add a public ToolCliContext progress seam or consume the private symbol directly.',
      type: 'external-adapter-progress-private-bridge',
    },
  ];
}

export const externalAdapterProgressPrivateBridge = defineCheck({
  id: '796d6b94-16c5-47e8-8f52-7d6cfaa2c8a5',
  slug: 'external-adapter-progress-private-bridge',
  description:
    'External adapter progress bridge helpers are private to the CLI worker shim and external-tool-adapter substrate',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture', 'adapters'],
  fileTypes: ['ts'],
  contentFilter: 'raw',
  analyze: (content, filePath) => analyzeExternalAdapterProgressPrivateBridge(content, filePath),
});
