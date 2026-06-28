import { createSignal, ValidationError } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { defineExternalToolAdapter } from '../define-external-tool-adapter.js';
import { messageHashFingerprintStrategy } from '../fingerprint.js';

import type { ExternalToolAdapterSpec } from '../types.js';

const baseSpec: ExternalToolAdapterSpec = {
  identity: { name: 'examplescan', aliases: ['ex'] },
  metadata: {
    id: 'c0ffee00-1234-4abc-8def-0123456789ab',
    description: 'Example scanner',
    version: '1.2.3',
    adapterPackage: '@opensip-cli/tool-example',
  },
  binary: { command: 'examplescan', versionArgs: ['version'], minVersion: '1.0.0' },
  network: 'local-only',
  commands: [
    {
      name: 'scan',
      args: (ctx) => ['scan', ctx.projectRoot],
      output: { kind: 'sarif', path: 'example.sarif' },
    },
  ],
};

describe('defineExternalToolAdapter', () => {
  it('returns an ordinary Tool with identity + metadata derived', () => {
    const tool = defineExternalToolAdapter(baseSpec);
    expect(tool.identity.name).toBe('examplescan');
    expect(tool.metadata).toMatchObject({
      id: 'c0ffee00-1234-4abc-8def-0123456789ab',
      name: 'examplescan',
      version: '1.2.3',
      description: 'Example scanner',
    });
  });

  it('mounts the scan primary + nested doctor + version (3 specs)', () => {
    const tool = defineExternalToolAdapter(baseSpec);
    const specs = tool.commandSpecs ?? [];
    expect(specs.map((s) => s.name)).toEqual(['examplescan', 'doctor', 'version']);

    const [primary, doctor, version] = specs;
    expect(primary).toMatchObject({
      name: 'examplescan',
      scope: 'project',
      output: 'raw-stream',
      rawStreamReason: 'runtime-render-dispatch',
    });
    expect(primary.aliases).toEqual(['ex']);
    expect(doctor).toMatchObject({
      name: 'doctor',
      parent: 'examplescan',
      scope: 'none',
      output: 'raw-stream',
      rawStreamReason: 'diagnostic-gate',
    });
    expect(version).toMatchObject({
      name: 'version',
      parent: 'examplescan',
      scope: 'none',
      output: 'raw-stream',
      rawStreamReason: 'diagnostic-gate',
    });
  });

  it('mounts additional scanner commands as nested verbs', () => {
    const tool = defineExternalToolAdapter({
      ...baseSpec,
      commands: [
        baseSpec.commands[0],
        { name: 'config', args: () => ['config'], output: { kind: 'sarif' } },
      ],
    });
    expect((tool.commandSpecs ?? []).map((s) => s.name)).toEqual([
      'examplescan',
      'config',
      'doctor',
      'version',
    ]);
  });

  it('declares the message-hash fingerprint strategy by default (worker-side stamping)', () => {
    const tool = defineExternalToolAdapter(baseSpec);
    expect(tool.extensionPoints?.fingerprintStrategy).toBe(messageHashFingerprintStrategy);
  });

  it('forwards an optional config contribution', () => {
    const tool = defineExternalToolAdapter({ ...baseSpec, config: { schema: { marker: true } } });
    expect(tool.extensionPoints?.config).toMatchObject({
      namespace: 'examplescan',
      schema: { marker: true },
    });
  });

  it('rejects a non-SARIF command with no parse', () => {
    expect(() =>
      defineExternalToolAdapter({
        ...baseSpec,
        commands: [{ name: 'scan', args: () => [], output: { kind: 'json', path: 'x.json' } }],
      }),
    ).toThrow(ValidationError);
  });

  it('accepts a JSON command WITH a parse', () => {
    const tool = defineExternalToolAdapter({
      ...baseSpec,
      commands: [
        {
          name: 'scan',
          args: () => [],
          output: { kind: 'json', path: 'x.json' },
          parse: () => [createSignal({ source: 'x', severity: 'low', ruleId: 'r', message: 'm' })],
        },
      ],
    });
    expect(tool.commandSpecs).toBeDefined();
  });

  it('rejects an empty command list', () => {
    expect(() => defineExternalToolAdapter({ ...baseSpec, commands: [] })).toThrow(ValidationError);
  });
});
