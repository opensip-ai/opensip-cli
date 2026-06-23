/**
 * @fileoverview Unit tests for `synthesizeExternalTool` (ADR-0054 M4-G): the
 * manifest → synthetic Tool builder the HOST uses to mount an external tool's
 * commands without importing its runtime.
 */

import { SystemError, type ToolPluginManifest } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { synthesizeExternalTool } from '../bootstrap/synthesize-external-tool.js';

function manifest(over: Partial<ToolPluginManifest> = {}): ToolPluginManifest {
  return {
    kind: 'tool',
    id: 'ext-tool',
    identity: { name: 'ext-tool', layoutKey: 'ext' },
    name: 'ext-tool',
    version: '1.2.3',
    apiVersion: 1,
    commands: [
      {
        name: 'ext-tool',
        description: 'run ext',
        commonFlags: ['cwd', 'json'],
        options: [{ flag: '--mode', value: '<m>', description: 'mode' }],
        scope: 'project',
        output: 'signal-envelope',
      },
    ],
    ...over,
  };
}

describe('synthesizeExternalTool (ADR-0054 M4-G)', () => {
  it('builds a Tool whose metadata + command shells derive from the manifest', () => {
    const tool = synthesizeExternalTool(
      manifest({ stableId: '00000000-0000-4000-8000-00000000ext1' }),
    );
    expect(tool.metadata.id).toBe('00000000-0000-4000-8000-00000000ext1');
    expect(tool.metadata.name).toBe('ext-tool');
    expect(tool.metadata.version).toBe('1.2.3');
    expect(tool.commandSpecs.map((s) => s.name)).toEqual(['ext-tool']);
    const spec = tool.commandSpecs[0];
    expect(spec?.commonFlags).toEqual(['cwd', 'json']);
    expect(spec?.options).toEqual([{ flag: '--mode', value: '<m>', description: 'mode' }]);
    expect(spec?.scope).toBe('project');
    expect(spec?.output).toBe('signal-envelope');
  });

  it('falls back to the manifest id as metadata.id when no stableId is declared', () => {
    const tool = synthesizeExternalTool(manifest());
    expect(tool.metadata.id).toBe('ext-tool');
  });

  it('carries NO extensionPoints (the host runs no external runtime hooks)', () => {
    const tool = synthesizeExternalTool(manifest());
    expect(tool.extensionPoints).toBeUndefined();
  });

  it('every synthetic handler is the fail-loud dispatch stub (host never calls it)', () => {
    const tool = synthesizeExternalTool(manifest());
    expect(() => tool.commandSpecs[0]?.handler({}, {} as never)).toThrow(SystemError);
    try {
      tool.commandSpecs[0]?.handler({}, {} as never);
    } catch (error) {
      expect((error as SystemError).code).toBe('SYSTEM.DISPATCH.EXTERNAL_HANDLER_UNREACHABLE');
    }
  });

  it('carries the pluginLayout so the host mounts the <tool> plugin group', () => {
    const tool = synthesizeExternalTool(
      manifest({ pluginLayout: { domain: 'ext', userSubdirs: ['checks'] } }),
    );
    expect(tool.pluginLayout).toEqual({ domain: 'ext', userSubdirs: ['checks'] });
  });

  it('omits pluginLayout when the manifest declares none', () => {
    const tool = synthesizeExternalTool(manifest());
    expect(tool.pluginLayout).toBeUndefined();
  });

  it('applies CommandSpec defaults for shell fields the manifest omits', () => {
    const tool = synthesizeExternalTool(
      manifest({
        identity: { name: 'bare' },
        id: 'bare',
        commands: [{ name: 'bare', description: 'bare' }],
      }),
    );
    const spec = tool.commandSpecs[0];
    expect(spec?.commonFlags).toEqual([]);
    expect(spec?.scope).toBe('project');
    expect(spec?.output).toBe('command-result');
  });
});
