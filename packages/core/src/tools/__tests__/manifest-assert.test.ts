/**
 * Tests for the load-time manifest⇔Tool drift guard (release 2.8.0, Phase 1).
 */

import { describe, expect, it } from 'vitest';

import { ValidationError } from '../../lib/errors.js';
import { assertManifestMatchesTool } from '../manifest-assert.js';

import type { ToolPluginManifest } from '../manifest.js';
import type { Tool } from '../types.js';

/** Minimal Tool stub — only the fields the guard inspects are meaningful. */
function makeTool(id: string, commandNames: readonly string[]): Tool {
  return {
    metadata: { id: '00000000-0000-4000-8000-000000000000', name: id, version: '0.0.0', description: 'test tool' },
    commands: commandNames.map((name) => ({ name, description: `${name} desc` })),
  };
}

function makeManifest(id: string, commandNames: readonly string[]): ToolPluginManifest {
  return {
    kind: 'tool',
    id,
    name: '@scope/test',
    version: '0.0.0',
    apiVersion: 1,
    commands: commandNames.map((name) => ({ name, description: `${name} desc` })),
  };
}

describe('assertManifestMatchesTool', () => {
  it('passes when id and command-name set match exactly', () => {
    const tool = makeTool('fitness', ['fit', 'fit-list', 'fit-recipes']);
    const manifest = makeManifest('fitness', ['fit', 'fit-list', 'fit-recipes']);
    expect(() => assertManifestMatchesTool(manifest, tool)).not.toThrow();
  });

  it('passes when command names match but order differs (set equality)', () => {
    const tool = makeTool('graph', ['graph', 'graph-lookup', 'sarif-export']);
    const manifest = makeManifest('graph', ['sarif-export', 'graph', 'graph-lookup']);
    expect(() => assertManifestMatchesTool(manifest, tool)).not.toThrow();
  });

  it('throws a ValidationError when the id differs', () => {
    const tool = makeTool('fitness', ['fit']);
    const manifest = makeManifest('fit', ['fit']);
    expect(() => assertManifestMatchesTool(manifest, tool)).toThrow(ValidationError);
    expect(() => assertManifestMatchesTool(manifest, tool)).toThrow(
      /manifest id 'fit'.*runtime tool id 'fitness'/,
    );
  });

  it('throws when a command is missing from the manifest', () => {
    const tool = makeTool('graph', ['graph', 'graph-lookup']);
    const manifest = makeManifest('graph', ['graph']);
    expect(() => assertManifestMatchesTool(manifest, tool)).toThrow(ValidationError);
    expect(() => assertManifestMatchesTool(manifest, tool)).toThrow(
      /missing from manifest: \[graph-lookup\]/,
    );
  });

  it('throws when the manifest declares an extra command the tool lacks', () => {
    const tool = makeTool('graph', ['graph']);
    const manifest = makeManifest('graph', ['graph', 'graph-ghost']);
    expect(() => assertManifestMatchesTool(manifest, tool)).toThrow(ValidationError);
    expect(() => assertManifestMatchesTool(manifest, tool)).toThrow(
      /declared in manifest but not in tool: \[graph-ghost\]/,
    );
  });
});
