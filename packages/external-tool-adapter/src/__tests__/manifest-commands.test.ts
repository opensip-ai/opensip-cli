import { describe, expect, it } from 'vitest';

import { defineExternalToolAdapter } from '../define-external-tool-adapter.js';
import { deriveAdapterManifestCommands } from '../manifest-commands.js';

import type { ExternalToolAdapterSpec } from '../types.js';

const spec: ExternalToolAdapterSpec = {
  identity: { name: 'examplescan', aliases: ['ex'] },
  metadata: {
    id: 'c0ffee00-1234-4abc-8def-0123456789ab',
    description: 'Example scanner',
    version: '1.2.3',
  },
  binary: { command: 'examplescan', versionArgs: ['version'] },
  network: 'local-only',
  commands: [
    {
      name: 'scan',
      args: (ctx) => [ctx.projectRoot],
      output: { kind: 'sarif', path: 'example.sarif' },
    },
  ],
};

describe('deriveAdapterManifestCommands', () => {
  it('derives serializable scan/doctor/version shells matching the runtime commandSpecs', () => {
    const tool = defineExternalToolAdapter(spec);
    const shells = deriveAdapterManifestCommands(tool);

    expect(shells.map((s) => s.name)).toEqual(['examplescan', 'doctor', 'version']);

    const primary = shells[0];
    expect(primary).toEqual({
      name: 'examplescan',
      description: 'Example scanner',
      aliases: ['ex'],
      commonFlags: ['json', 'cwd', 'quiet', 'verbose', 'debug', 'reportTo', 'apiKey', 'open'],
      scope: 'project',
      output: 'raw-stream',
      rawStreamReason: 'runtime-render-dispatch',
    });

    const doctor = shells[1];
    expect(doctor).toMatchObject({
      name: 'doctor',
      parent: 'examplescan',
      scope: 'none',
      output: 'raw-stream',
      rawStreamReason: 'diagnostic-gate',
      commonFlags: ['json', 'cwd'],
    });

    // The whole thing is JSON-serializable (it is written into package.json).
    expect(() => JSON.stringify(shells)).not.toThrow();
  });

  it('returns an empty list for a tool with no commandSpecs', () => {
    expect(deriveAdapterManifestCommands({ commandSpecs: undefined } as never)).toEqual([]);
  });
});
