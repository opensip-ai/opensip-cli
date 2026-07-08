import { describe, expect, it } from 'vitest';

import { analyzeExternalToolAdapterContracts } from '../checks/external-tool-adapter-contract.js';

import type { FileAccessor } from '@opensip-cli/fitness';

const CLEAN_PACKAGE = {
  name: '@opensip-cli/tool-clean',
  dependencies: {
    '@opensip-cli/core': 'workspace:*',
    '@opensip-cli/external-tool-adapter': 'workspace:*',
  },
  opensipTools: {
    kind: 'tool',
    id: 'clean',
    apiVersion: 1,
    commands: [
      { name: 'clean', description: 'scan', output: 'raw-stream' },
      { name: 'doctor', parent: 'clean', description: 'doctor', output: 'raw-stream' },
      { name: 'version', parent: 'clean', description: 'version', output: 'raw-stream' },
    ],
    requires: [
      { resource: 'subprocess', reason: 'runs scanner' },
      { resource: 'filesystem', reason: 'reads project' },
    ],
    config: { namespace: 'clean', schema: { type: 'object' } },
  },
};

const CLEAN_TOOL = `
import { defineExternalToolAdapter } from '@opensip-cli/external-tool-adapter';
import type { Tool } from '@opensip-cli/core';
export const tool: Tool = defineExternalToolAdapter({
  identity: { name: 'clean' },
  metadata: { id: '1', version: '1', description: 'clean', adapterPackage: '@opensip-cli/tool-clean' },
  binary: { command: 'clean', versionArgs: ['--version'], resolution: ['path'] },
  network: 'local-only',
  commands: [],
});
`;

function fakeAccessor(files: Record<string, string>): FileAccessor {
  return {
    paths: Object.keys(files),
    read: (path) => Promise.resolve(files[path] ?? ''),
    readMany: (paths) => Promise.resolve(new Map(paths.map((path) => [path, files[path] ?? '']))),
    readAll: () => Promise.resolve(new Map(Object.entries(files))),
  };
}

describe('external-tool-adapter-contract', () => {
  it('accepts a conformant adapter package', async () => {
    const files = fakeAccessor({
      '/repo/packages/tool-clean/package.json': JSON.stringify(CLEAN_PACKAGE),
      '/repo/packages/tool-clean/src/tool.ts': CLEAN_TOOL,
    });

    await expect(analyzeExternalToolAdapterContracts(files)).resolves.toEqual([]);
  });

  it('is self-targeting and ignores non-adapter tool packages', async () => {
    const files = fakeAccessor({
      '/repo/packages/fitness/engine/package.json': JSON.stringify({
        name: '@opensip-cli/fitness',
        opensipTools: { kind: 'tool', id: 'fitness', apiVersion: 1, commands: [] },
      }),
      '/repo/packages/fitness/engine/src/tool.ts': 'export const x = 1;\n',
    });

    await expect(analyzeExternalToolAdapterContracts(files)).resolves.toEqual([]);
  });

  it('flags a hand-rolled adapter source and missing manifest requirements', async () => {
    const pkg = {
      ...CLEAN_PACKAGE,
      opensipTools: {
        ...CLEAN_PACKAGE.opensipTools,
        commands: [{ name: 'bad', description: 'bad', output: 'live-view' }],
        requires: [{ resource: 'filesystem', reason: 'reads project' }],
        config: {},
      },
    };
    const files = fakeAccessor({
      '/repo/packages/tool-bad/package.json': JSON.stringify(pkg),
      '/repo/packages/tool-bad/src/tool.ts': `
        import { execFile } from 'node:child_process';
        import { defineTool } from '@opensip-cli/core';
        import { SessionRepo } from '@opensip-cli/session-store';
        console.log('bad');
        export const tool = defineTool({});
        execFile('scanner', []);
      `,
    });

    const violations = await analyzeExternalToolAdapterContracts(files);

    expect(new Set(violations.map((violation) => violation.type))).toEqual(
      new Set([
        'external-adapter-config',
        'external-adapter-requires',
        'external-adapter-live-view-output',
        'external-adapter-doctor',
        'external-adapter-version',
        'external-adapter-subprocess',
        'external-adapter-define-tool',
        'external-adapter-persistence',
        'external-adapter-output',
        'external-adapter-substrate',
      ]),
    );
  });

  it('skips comments and test files when checking runtime source', async () => {
    const files = fakeAccessor({
      '/repo/packages/tool-clean/package.json': JSON.stringify(CLEAN_PACKAGE),
      '/repo/packages/tool-clean/src/tool.ts': `${CLEAN_TOOL}\n// execFile('scanner')\n`,
      '/repo/packages/tool-clean/src/__tests__/tool.test.ts':
        "import { execFile } from 'node:child_process';\n",
    });

    await expect(analyzeExternalToolAdapterContracts(files)).resolves.toEqual([]);
  });
});
