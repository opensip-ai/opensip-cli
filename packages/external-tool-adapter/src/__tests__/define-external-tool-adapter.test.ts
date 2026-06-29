import { createSignal, ValidationError } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { deriveAdapterConfigManifest, deriveAdapterManifestRequires } from '../adapter-manifest.js';
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

  // A4 / R6 (ADR-0090 §4.3): an adapter that declares NO `config` must still CLAIM
  // its namespace by default — otherwise `scope.toolConfig[<tool>]` is always
  // undefined (binary pin dead, verdict keys non-configurable, and an operator's
  // `<tool>:` block bricks the project via the ADR-0043 unclaimed-namespace gate).
  describe('default config namespace claim (A4 / R6)', () => {
    it('claims the namespace on the runtime when config is omitted', () => {
      const tool = defineExternalToolAdapter(baseSpec);
      const config = tool.extensionPoints?.config;
      expect(config?.namespace).toBe('examplescan');
      // The runtime schema is the worker deep-pass Zod (exposes safeParse).
      expect(typeof (config?.schema as { safeParse?: unknown }).safeParse).toBe('function');
    });

    it('the runtime schema accepts the binary pin AND the reserved verdict keys', () => {
      const tool = defineExternalToolAdapter(baseSpec);
      const schema = tool.extensionPoints?.config?.schema as {
        safeParse: (v: unknown) => { success: boolean };
      };
      expect(
        schema.safeParse({
          binaries: { examplescan: { path: '/opt/examplescan' } },
          failOnWarnings: 2,
          failOnDegraded: false,
        }).success,
      ).toBe(true);
      // A typo inside the block is rejected by the deep pass (strict).
      expect(schema.safeParse({ binares: {} }).success).toBe(false);
    });

    it('emits a coarse static config descriptor (the installed-path namespace claim)', () => {
      const tool = defineExternalToolAdapter(baseSpec);
      const descriptor = deriveAdapterConfigManifest(tool);
      expect(descriptor?.namespace).toBe('examplescan');
      expect(descriptor?.schema.properties?.binaries).toEqual({ type: 'object' });
    });

    it('emits NO static descriptor for a custom config (validation defers to the worker)', () => {
      const tool = defineExternalToolAdapter({ ...baseSpec, config: { schema: { marker: true } } });
      expect(deriveAdapterConfigManifest(tool)).toBeUndefined();
    });
  });

  // A13 (ADR-0092 §4.8): `requires` is DERIVED from the network posture — the
  // documented forward-map, not a hand-typed list. `network` rides only on a
  // non-local-only posture, so a future flip to `networked` is a visible drift.
  describe('network posture → requires derivation (A13)', () => {
    it('a local-only adapter derives [subprocess, filesystem] (no network)', () => {
      const requires = deriveAdapterManifestRequires(defineExternalToolAdapter(baseSpec));
      expect(requires.map((r) => r.resource)).toEqual(['subprocess', 'filesystem']);
    });

    it('a networked adapter derives an added network requirement', () => {
      const tool = defineExternalToolAdapter({ ...baseSpec, network: 'networked' });
      const requires = deriveAdapterManifestRequires(tool);
      expect(requires.map((r) => r.resource)).toEqual(['subprocess', 'filesystem', 'network']);
      expect(requires.find((r) => r.resource === 'network')?.reason).toContain('networked');
    });

    it('an auth-required adapter also derives a network requirement', () => {
      const tool = defineExternalToolAdapter({ ...baseSpec, network: 'auth-required' });
      expect(deriveAdapterManifestRequires(tool).some((r) => r.resource === 'network')).toBe(true);
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
