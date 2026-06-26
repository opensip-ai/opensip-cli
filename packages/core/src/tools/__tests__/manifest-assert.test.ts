/**
 * Tests for the load-time manifest⇔Tool drift guard (release 2.8.0, Phase 1).
 */

import { describe, expect, it } from 'vitest';

import { ValidationError } from '../../lib/errors.js';
import { assertManifestMatchesTool } from '../manifest-assert.js';

import type { CommandSpec } from '../command-spec.js';
import type { ToolPluginManifest } from '../manifest.js';
import type { Tool, ToolCliContext } from '../types.js';

/** Minimal Tool stub — only the fields the guard inspects are meaningful. */
function makeTool(
  humanName: string,
  commandNames: readonly string[],
  stableId = '00000000-0000-4000-8000-000000000000',
): Tool {
  return {
    identity: { name: humanName },
    metadata: { id: stableId, name: humanName, version: '0.0.0', description: 'test tool' },
    commands: commandNames.map((name) => ({ name, description: `${name} desc` })),
  };
}

function makeManifest(
  humanId: string,
  commandNames: readonly string[],
  stableId?: string,
): ToolPluginManifest {
  return {
    kind: 'tool',
    id: humanId,
    identity: { name: humanId },
    ...(stableId ? { stableId } : {}),
    name: '@scope/test',
    version: '0.0.0',
    apiVersion: 1,
    commands: commandNames.map((name) => ({ name, description: `${name} desc` })),
  };
}

describe('assertManifestMatchesTool', () => {
  it('passes when human id/name and command-name set match exactly', () => {
    const tool = makeTool(
      'fitness',
      ['fit', 'fit-list', 'fit-recipes'],
      'afd68bd3-ff3c-4935-a5b6-76d8fc7a5224',
    );
    const manifest = makeManifest(
      'fitness',
      ['fit', 'fit-list', 'fit-recipes'],
      'afd68bd3-ff3c-4935-a5b6-76d8fc7a5224',
    );
    expect(() => assertManifestMatchesTool(manifest, tool)).not.toThrow();
  });

  it('passes when command names match but order differs (set equality)', () => {
    const tool = makeTool('graph', ['graph', 'graph-lookup', 'sarif-export']);
    const manifest = makeManifest('graph', ['sarif-export', 'graph', 'graph-lookup']);
    expect(() => assertManifestMatchesTool(manifest, tool)).not.toThrow();
  });

  it('passes when manifest omits stableId (additive, legacy compat)', () => {
    const tool = makeTool('fitness', ['fit'], 'afd68bd3-ff3c-4935-a5b6-76d8fc7a5224');
    const manifest = makeManifest('fitness', ['fit']); // no stableId
    expect(() => assertManifestMatchesTool(manifest, tool)).not.toThrow();
  });

  it('throws a ValidationError when the human id (manifest) differs from runtime name', () => {
    const tool = makeTool('fitness', ['fit']);
    const manifest = makeManifest('fit', ['fit']);
    expect(() => assertManifestMatchesTool(manifest, tool)).toThrow(ValidationError);
    expect(() => assertManifestMatchesTool(manifest, tool)).toThrow(
      /manifest id 'fit'.*runtime tool name 'fitness'/,
    );
  });

  it('throws when manifest stableId differs from runtime id', () => {
    const tool = makeTool('fitness', ['fit'], 'afd68bd3-ff3c-4935-a5b6-76d8fc7a5224');
    const manifest = makeManifest('fitness', ['fit'], '11111111-1111-4111-8111-111111111111');
    expect(() => assertManifestMatchesTool(manifest, tool)).toThrow(ValidationError);
    expect(() => assertManifestMatchesTool(manifest, tool)).toThrow(
      /manifest stableId '11111111-1111-4111-8111-111111111111'.*runtime tool id 'afd68bd3-ff3c-4935-a5b6-76d8fc7a5224'/,
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

  it('throws when manifest identity fields drift from runtime identity', () => {
    const tool = { ...makeTool('fitness', ['fitness']), identity: { name: 'fitness' } };
    expect(() =>
      assertManifestMatchesTool(
        { ...makeManifest('fitness', ['fitness']), identity: { name: 'fit' } },
        tool,
      ),
    ).toThrow(/identity\.name/);
    expect(() =>
      assertManifestMatchesTool({ ...makeManifest('fitness', ['fitness']), id: 'fit' }, tool),
    ).toThrow(/manifest id 'fit'/);
    expect(() =>
      assertManifestMatchesTool(
        { ...makeManifest('fitness', ['fitness']), identity: { name: 'fit' } },
        { ...tool, identity: { name: 'fit' } },
      ),
    ).toThrow(/must equal identity\.name/);
    expect(() =>
      assertManifestMatchesTool(
        { ...makeManifest('fitness', ['fitness']), identity: { name: 'fitness', aliases: ['f'] } },
        { ...tool, identity: { name: 'fitness', aliases: ['fit'] } },
      ),
    ).toThrow(/identity\.aliases/);
    expect(() =>
      assertManifestMatchesTool(
        {
          ...makeManifest('fitness', ['fitness']),
          identity: { name: 'fitness', aliases: ['fit', 'f'] },
        },
        { ...tool, identity: { name: 'fitness', aliases: ['fit'] } },
      ),
    ).toThrow(/identity\.aliases/);
  });

  it('throws when manifest or runtime layout/config derived fields drift', () => {
    const tool = { ...makeTool('fitness', ['fitness']), identity: { name: 'fitness' } };

    expect(() =>
      assertManifestMatchesTool(
        {
          ...makeManifest('fitness', ['fitness']),
          identity: { name: 'fitness', layoutKey: 'fit' },
          pluginLayout: { domain: 'wrong', userSubdirs: [] },
        },
        tool,
      ),
    ).toThrow(/pluginLayout\.domain/);

    expect(() =>
      assertManifestMatchesTool(makeManifest('fitness', ['fitness']), {
        ...tool,
        pluginLayout: { domain: 'wrong', userSubdirs: [] },
      }),
    ).toThrow(/runtime pluginLayout\.domain/);

    expect(() =>
      assertManifestMatchesTool(
        {
          ...makeManifest('fitness', ['fitness']),
          config: { namespace: 'wrong', schema: {} },
        },
        tool,
      ),
    ).toThrow(/config\.namespace/);
  });

  it('throws when primary command aliases or replay layout drift', () => {
    const primary: CommandSpec<unknown, ToolCliContext> = {
      name: 'fitness',
      aliases: ['wrong'],
      description: 'Run',
      commonFlags: [],
      scope: 'project',
      output: 'command-result',
      handler: () => undefined,
    };
    const tool = {
      ...makeTool('fitness', ['fitness']),
      identity: { name: 'fitness', aliases: ['fit'], layoutKey: 'fit' },
      commandSpecs: [primary],
    };
    const manifest = {
      ...makeManifest('fitness', ['fitness']),
      identity: { name: 'fitness', aliases: ['fit'], layoutKey: 'fit' },
    };

    expect(() => assertManifestMatchesTool(manifest, tool)).toThrow(/primary command aliases/);

    expect(() =>
      assertManifestMatchesTool(manifest, {
        ...makeTool('fitness', ['fitness']),
        identity: { name: 'fitness', aliases: ['fit'], layoutKey: 'fit' },
        commandSpecs: [{ ...primary, aliases: ['fit'] }],
      }),
    ).not.toThrow();

    expect(() =>
      assertManifestMatchesTool(manifest, {
        ...makeTool('fitness', ['fitness']),
        identity: { name: 'fitness', aliases: ['fit'], layoutKey: 'fit' },
        pluginLayout: { domain: 'fit', userSubdirs: [] },
        extensionPoints: {
          sessionReplay: { tool: 'wrong', replaySession: () => ({}) },
        },
      }),
    ).toThrow(/sessionReplay\.tool/);
  });

  it('passes when the runtime descriptor exposes extensionPoints.contractVersions', () => {
    const tool = {
      ...makeTool('fitness', ['fit']),
      extensionPoints: {
        contractVersions: {
          fitness: '1.0.0',
        },
      },
    };
    const manifest = makeManifest('fitness', ['fit']);
    expect(() => assertManifestMatchesTool(manifest, tool)).not.toThrow();
  });

  it('does not require removed named contract version fields', () => {
    const tool = makeTool('fitness', ['fit']);
    const manifest = makeManifest('fitness', ['fit']);
    expect(() => assertManifestMatchesTool(manifest, tool)).not.toThrow();
  });

  it('reports sorted multi-command drift on both sides', () => {
    const tool = makeTool('graph', ['graph', 'graph-lookup', 'graph-index']);
    const manifest = makeManifest('graph', ['graph', 'graph-alpha', 'graph-beta']);

    expect(() => assertManifestMatchesTool(manifest, tool)).toThrow(
      /missing from manifest: \[graph-index, graph-lookup\].*declared in manifest but not in tool: \[graph-alpha, graph-beta\]/,
    );
  });
});
