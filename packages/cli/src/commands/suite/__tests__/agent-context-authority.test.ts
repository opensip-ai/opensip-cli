import {
  defineCommand,
  type Tool,
  type ToolCliContext,
  type ToolProvenance,
} from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { validateBuiltInAgentContextAuthority } from '../agent-context-authority.js';
import {
  BUILT_IN_AGENT_CONTEXT_PLANES,
  BUILT_IN_AGENT_CONTEXT_SUITE,
  BUILT_IN_GRAPH_PACKAGE_NAME,
  BUILT_IN_GRAPH_TOOL_ID,
  BUILT_IN_GRAPH_TOOL_NAME,
} from '../built-in-suites.js';
import { validateSuite } from '../validate-suite.js';

const VERSION = '0.6.0';
const SOURCE_PATH = 'packages/graph/engine/src/cli/context/context-command-specs.ts';

function graphTool(overrides: { readonly firstDeclaration?: string } = {}): Tool {
  const commandSpecs = BUILT_IN_AGENT_CONTEXT_PLANES.map((plane, index) =>
    defineCommand<unknown, ToolCliContext>({
      name: plane.command,
      visibility: 'internal',
      description: 'fixture context evidence',
      commonFlags: [],
      scope: 'project',
      output: 'raw-stream',
      rawStreamReason: 'host-orchestrated-evidence',
      producesEvidenceSnapshot: true,
      staticHandler: {
        package: BUILT_IN_GRAPH_PACKAGE_NAME,
        path: SOURCE_PATH,
        declaration:
          index === 0 && overrides.firstDeclaration !== undefined
            ? overrides.firstDeclaration
            : plane.declaration,
      },
      handler: () => undefined,
    }),
  );
  return {
    identity: { name: BUILT_IN_GRAPH_TOOL_NAME },
    metadata: {
      id: BUILT_IN_GRAPH_TOOL_ID,
      name: BUILT_IN_GRAPH_TOOL_NAME,
      version: VERSION,
      description: 'fixture graph',
    },
    commands: commandSpecs.map((spec) => ({ name: spec.name, description: spec.description })),
    commandSpecs,
  };
}

function bundledProvenance(overrides: Partial<ToolProvenance> = {}): ToolProvenance {
  return {
    source: 'bundled',
    id: BUILT_IN_GRAPH_TOOL_NAME,
    stableId: BUILT_IN_GRAPH_TOOL_ID,
    version: VERSION,
    packageName: BUILT_IN_GRAPH_PACKAGE_NAME,
    manifestHash: 'fixture-manifest-hash',
    ...overrides,
  };
}

function validated(tool = graphTool()) {
  return validateSuite({
    name: 'agent-context',
    suite: BUILT_IN_AGENT_CONTEXT_SUITE,
    tools: [tool],
  });
}

describe('validateBuiltInAgentContextAuthority', () => {
  it('accepts only the exact admitted bundled graph producer chain', () => {
    expect(
      validateBuiltInAgentContextAuthority({
        suite: validated(),
        provenance: [bundledProvenance()],
      }),
    ).toEqual({ producerVersion: VERSION });
  });

  it('fails closed when provenance is absent or not the bundled graph package', () => {
    expect(() =>
      validateBuiltInAgentContextAuthority({ suite: validated(), provenance: [] }),
    ).toThrow(/exactly one admitted graph provenance record/);
    expect(() =>
      validateBuiltInAgentContextAuthority({
        suite: validated(),
        provenance: [bundledProvenance({ source: 'installed' })],
      }),
    ).toThrow(/does not match the admitted bundled package/);
    expect(() =>
      validateBuiltInAgentContextAuthority({
        suite: validated(),
        provenance: [bundledProvenance({ packageName: '@attacker/graph' })],
      }),
    ).toThrow(/does not match the admitted bundled package/);
  });

  it('rejects a same-name command that lacks the exact internal handler descriptor', () => {
    expect(() =>
      validateBuiltInAgentContextAuthority({
        suite: validated(graphTool({ firstDeclaration: 'spoofedHandler' })),
        provenance: [bundledProvenance()],
      }),
    ).toThrow(/step 1 is not the expected internal graph producer/);
  });
});
