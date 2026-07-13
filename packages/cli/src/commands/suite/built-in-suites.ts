import type { SuiteDefinition, SuitesConfig } from '@opensip-cli/config';

export const BUILT_IN_AUDIT_SUITE_NAME = 'audit';
export const BUILT_IN_AGENT_CONTEXT_SUITE_NAME = 'agent-context';
export const BUILT_IN_GRAPH_TOOL_ID = '3873f1c2-02a9-4719-930a-bca74b62b706';
export const BUILT_IN_GRAPH_TOOL_NAME = 'graph';
export const BUILT_IN_GRAPH_PACKAGE_NAME = '@opensip-cli/graph';

/**
 * Closed execution/provenance map for the trusted built-in task-context plane.
 * The host checks this map both before execution and while aggregating returned
 * contributions; command names alone are not an authority boundary.
 */
export const BUILT_IN_AGENT_CONTEXT_PLANES = [
  {
    kind: 'inventory',
    command: 'graph-context-inventory',
    declaration: 'graphContextInventoryCommandSpec',
  },
  {
    kind: 'graph',
    command: 'graph-context-ensure',
    declaration: 'graphContextEnsureCommandSpec',
  },
  {
    kind: 'test-selection',
    command: 'graph-context-select-tests',
    declaration: 'graphContextSelectTestsCommandSpec',
  },
] as const;

export const BUILT_IN_AUDIT_SUITE = {
  description:
    'PR-review workflow: changed-code risk, graph impact, and high-confidence reduction candidates',
  steps: [
    {
      tool: 'afd68bd3-ff3c-4935-a5b6-76d8fc7a5224',
      name: 'fitness',
      command: 'fitness',
      args: { recipe: 'agent-risk' },
    },
    {
      tool: BUILT_IN_GRAPH_TOOL_ID,
      name: 'graph',
      command: 'impact',
      args: {},
    },
    {
      tool: '3aba9195-2297-4f20-99d5-906945092dfc',
      name: 'yagni',
      command: 'yagni',
      args: { minConfidence: 'high' },
    },
  ],
} as const satisfies SuiteDefinition;

export const BUILT_IN_AGENT_CONTEXT_SUITE = {
  description:
    'Before-edit project inventory, graph generation, and labelled static test-selection evidence',
  execution: { failOnFault: true },
  steps: BUILT_IN_AGENT_CONTEXT_PLANES.map((plane) => ({
    tool: BUILT_IN_GRAPH_TOOL_ID,
    name: BUILT_IN_GRAPH_TOOL_NAME,
    command: plane.command,
    args: {},
  })),
} as const satisfies SuiteDefinition;

export type SuiteSource = 'configured' | 'built-in';

export interface ResolvedSuite {
  readonly suite: SuiteDefinition;
  readonly source: SuiteSource;
}

export function suiteSource(
  name: string,
  configured: Readonly<SuitesConfig>,
): SuiteSource | undefined {
  if (configured[name] !== undefined) return 'configured';
  if (name === BUILT_IN_AUDIT_SUITE_NAME) return 'built-in';
  if (name === BUILT_IN_AGENT_CONTEXT_SUITE_NAME) return 'built-in';
  return undefined;
}

export function resolveSuite(
  name: string,
  configured: Readonly<SuitesConfig>,
): ResolvedSuite | undefined {
  const source = suiteSource(name, configured);
  if (source === 'configured') {
    const suite = configured[name];
    return suite === undefined ? undefined : { suite, source };
  }
  if (source === 'built-in') {
    return {
      suite:
        name === BUILT_IN_AGENT_CONTEXT_SUITE_NAME
          ? BUILT_IN_AGENT_CONTEXT_SUITE
          : BUILT_IN_AUDIT_SUITE,
      source,
    };
  }
  return undefined;
}

export function listSuites(
  configured: Readonly<SuitesConfig>,
): readonly (readonly [string, SuiteDefinition])[] {
  const entries: (readonly [string, SuiteDefinition])[] = Object.entries(configured);
  if (configured[BUILT_IN_AUDIT_SUITE_NAME] === undefined) {
    entries.push([BUILT_IN_AUDIT_SUITE_NAME, BUILT_IN_AUDIT_SUITE]);
  }
  if (configured[BUILT_IN_AGENT_CONTEXT_SUITE_NAME] === undefined) {
    entries.push([BUILT_IN_AGENT_CONTEXT_SUITE_NAME, BUILT_IN_AGENT_CONTEXT_SUITE]);
  }
  return entries;
}
