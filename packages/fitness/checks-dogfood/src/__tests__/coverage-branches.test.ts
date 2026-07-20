import { runCheckOnFixture } from '@opensip-cli/test-support';
import { describe, expect, it } from 'vitest';

import { analyzeCommandHandlerHostOwnedOutput } from '../checks/command-handler-host-owned-output.js';
import { analyzeExternalToolAdapterContracts } from '../checks/external-tool-adapter-contract.js';
import { firstPartyCommandStaticHandler } from '../checks/first-party-command-static-handler.js';
import { analyzeNoRunDoneResult } from '../checks/no-run-done-result.js';
import { analyzeSingleOptsAssemblySeam } from '../checks/single-opts-assembly-seam.js';
import { analyzeStringPrefilterSuperset } from '../checks/string-prefilter-superset.js';

import type { FileAccessor } from '@opensip-cli/fitness';

function fakeAccessor(files: Record<string, string>): FileAccessor {
  return {
    paths: Object.keys(files),
    read: (filePath) => Promise.resolve(files[filePath] ?? ''),
    readMany: (paths) =>
      Promise.resolve(new Map(paths.map((filePath) => [filePath, files[filePath] ?? '']))),
    readAll: () => Promise.resolve(new Map(Object.entries(files))),
  };
}

const ADAPTER_PACKAGE = {
  dependencies: {
    '@opensip-cli/external-tool-adapter': 'workspace:*',
  },
  opensipTools: {
    kind: 'tool',
    commands: [
      { name: 'scan', output: 'raw-stream' },
      { name: 'doctor', output: 'raw-stream' },
      { name: 'version', output: 'raw-stream' },
    ],
    requires: [{ resource: 'subprocess' }, { resource: 'filesystem' }],
    config: { namespace: 'adapter' },
  },
};

const SUBSTRATE_TOOL = `
import { defineExternalToolAdapter } from '@opensip-cli/external-tool-adapter';
const note = "scanner output";
/*
import { execFile } from 'node:child_process';
console.log('not runtime code');
*/
export const tool = defineExternalToolAdapter({});
`;

describe('single-opts-assembly-seam branch coverage', () => {
  it('flags for-of loops that assemble opts with parser defaults', () => {
    const violations = analyzeSingleOptsAssemblySeam(
      `
      export function project(spec) {
        const opts = {};
        for (const option of (spec.options)) {
          opts[option.name] = option.parse(option.default);
        }
        return opts;
      }
      `,
      'packages/cli/src/commands/suite/runner.ts',
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('project hand-rolls');
  });

  it('flags callback iterations that use element-access option defaults', () => {
    const violations = analyzeSingleOptsAssemblySeam(
      `
      export const build = (spec) => {
        const opts = {};
        spec['options'].map((option) => {
          opts[option.name] = option['arrayDefault'];
        });
        return opts;
      };
      `,
      'packages/cli/src/commands/suite/runner.ts',
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('build hand-rolls');
  });

  it('flags assignments into opts after declaration', () => {
    const violations = analyzeSingleOptsAssemblySeam(
      `
      export default function(spec) {
        let opts;
        for (const option of spec.options) {
          opts[option.name] = option.default;
        }
        return opts;
      }
      `,
      'packages/cli/src/commands/suite/runner.ts',
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('function hand-rolls');
  });

  it('ignores option loops that do not both read defaults and write opts', () => {
    expect(
      analyzeSingleOptsAssemblySeam(
        `
        export function readsOnly(spec) {
          return spec.options.map((option) => option.default);
        }
        export function writesOnly(spec) {
          const opts = {};
          for (const option of spec.options) opts[option.name] = option.name;
          return opts;
        }
        `,
        'packages/cli/src/commands/suite/runner.ts',
      ),
    ).toEqual([]);
  });
});

describe('external-tool-adapter-contract branch coverage', () => {
  it('skips malformed and non-adapter package manifests', async () => {
    const files = fakeAccessor({
      '/repo/packages/malformed/package.json': '{',
      '/repo/packages/plain/package.json': JSON.stringify({
        name: 'plain',
        opensipTools: { kind: 'tool', commands: [] },
      }),
      '/repo/packages/plain/src/tool.ts': 'export const x = 1;',
    });

    await expect(analyzeExternalToolAdapterContracts(files)).resolves.toEqual([]);
  });

  it('accepts peer-dependency adapters and ignores comments, strings, declarations, and tests', async () => {
    const files = fakeAccessor({
      '/repo/packages/peer/package.json': JSON.stringify({
        ...ADAPTER_PACKAGE,
        dependencies: {},
        peerDependencies: {
          '@opensip-cli/external-tool-adapter': 'workspace:*',
        },
        opensipTools: {
          ...ADAPTER_PACKAGE.opensipTools,
          id: 'peer-adapter',
        },
      }),
      '/repo/packages/peer/src/tool.ts': SUBSTRATE_TOOL,
      '/repo/packages/peer/src/types.d.ts': "import { execFile } from 'node:child_process';",
      '/repo/packages/peer/src/tool.test.ts': "console.warn('test-only');",
      '/repo/packages/peer/src/__tests__/tool.ts': 'process.exit(1);',
    });

    await expect(analyzeExternalToolAdapterContracts(files)).resolves.toEqual([]);
  });

  it('flags forbidden subprocess, persistence, and output effects in runtime sources', async () => {
    const files = fakeAccessor({
      '/repo/packages/bad/package.json': JSON.stringify({
        ...ADAPTER_PACKAGE,
        name: '',
        opensipTools: {
          ...ADAPTER_PACKAGE.opensipTools,
          id: '',
        },
      }),
      '/repo/packages/bad/src/tool.ts': `
        import { spawn } from 'node:child_process';
        import('@opensip-cli/datastore');
        import { defineExternalToolAdapter } from '@opensip-cli/external-tool-adapter';
        const SessionRepo = class {};
        console.warn('bad');
        process.stderr.write('bad');
        spawn('scanner', []);
        export const tool = defineExternalToolAdapter({});
      `,
    });

    const violations = await analyzeExternalToolAdapterContracts(files);
    const types = new Set(violations.map((violation) => violation.type));

    expect(types).toEqual(
      new Set([
        'external-adapter-subprocess',
        'external-adapter-persistence',
        'external-adapter-output',
      ]),
    );
  });
});

describe('command-handler-host-owned-output branch coverage', () => {
  it('flags method handlers and the console info/debug arms', () => {
    const violations = analyzeCommandHandlerHostOwnedOutput(
      `
      import { defineCommand } from '@opensip-cli/core';
      export const command = defineCommand({
        name: 'demo',
        output: 'command-result',
        handler() {
          console.info('info');
          console.debug('debug');
        },
      });
      `,
      'packages/tool/src/tool.ts',
    );

    expect(violations.map((violation) => violation.message)).toEqual([
      expect.stringContaining('console.info'),
      expect.stringContaining('console.debug'),
    ]);
  });
});

describe('no-run-done-result branch coverage', () => {
  it('flags interface names and type-literal done discriminators', () => {
    const violations = analyzeNoRunDoneResult(
      `
      export interface FitDoneResult {
        readonly ok: true;
      }
      export type RenderResult = {
        readonly type: 'graph-done';
      };
      `,
      'packages/contracts/src/command-results.ts',
    );

    expect(violations.map((violation) => violation.message)).toEqual([
      expect.stringContaining("Type 'FitDoneResult'"),
      expect.stringContaining("Type 'RenderResult'"),
    ]);
  });

  it('ignores unrelated aliases and done strings outside type discriminators', () => {
    expect(
      analyzeNoRunDoneResult(
        `
        const text = 'fit-done';
        export type RunPresentation = {
          readonly type: 'run-presentation';
        };
        `,
        'packages/contracts/src/command-results.ts',
      ),
    ).toEqual([]);
  });
});

describe('first-party-command-static-handler branch coverage', () => {
  it('recognizes the CLI host factory alias used by production command specs', async () => {
    const result = await runCheckOnFixture(firstPartyCommandStaticHandler, {
      files: [
        {
          path: 'packages/cli/src/commands/sample.ts',
          content: `
            import { defineHostCommand as defineCommand } from './host-runtime-access.js';
            export const sample = defineCommand({
              handler: () => undefined,
            });
          `,
        },
      ],
    });

    expect(result.findings).toHaveLength(1);
  });
});

describe('string-prefilter-superset branch coverage', () => {
  const CHECK_PATH = 'packages/fitness/checks-universal/src/checks/subject.ts';

  it('ignores QUICK_FILTER examples in comments and strings', () => {
    expect(
      analyzeStringPrefilterSuperset(
        `
        // const QUICK_FILTER = [' any'];
        const docs = "QUICK_FILTER = [' any']";
        `,
        CHECK_PATH,
      ),
    ).toEqual([]);
  });

  it('does not classify a multiline regex as an end-of-file anchor', () => {
    expect(
      analyzeStringPrefilterSuperset(
        'export const matches = /Repository$/m.test(content);\n',
        CHECK_PATH,
      ),
    ).toEqual([]);
  });
});
