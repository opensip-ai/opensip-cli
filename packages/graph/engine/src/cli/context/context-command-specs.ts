/** Hidden CommandSpecs mounted solely for the built-in agent-context suite. */

import { defineCommand, type CommandSpec, type ToolCliContext } from '@opensip-cli/core';

import {
  produceContextGraph,
  produceContextInventory,
  produceContextTestSelection,
} from './context-producers.js';

const PACKAGE = '@opensip-cli/graph';
const PATH = 'packages/graph/engine/src/cli/context/context-command-specs.ts';

/**
 * Raw-stream reason category `host-orchestrated-evidence`: these internal
 * handlers return bounded evidence contributions to the host run hook, while
 * the parent suite owns the only visible result. Normal command-result dispatch
 * would incorrectly render a second per-step document.
 */

interface ContextCommandOptions {
  readonly cwd: string;
  readonly files?: readonly string[];
}

const FILES_OPTION = {
  flag: '--files',
  value: '<path>',
  description: 'Explicit changed file (repeatable; project-relative)',
  arrayDefault: [] as readonly string[],
  parse: (value: string, prior: unknown) => [
    ...(Array.isArray(prior) ? (prior as readonly string[]) : []),
    value,
  ],
} as const;

export const graphContextInventoryCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  staticHandler: {
    package: PACKAGE,
    path: PATH,
    declaration: 'graphContextInventoryCommandSpec',
  },
  name: 'graph-context-inventory',
  visibility: 'internal',
  description: '[internal] Persist bounded project inventory context evidence',
  commonFlags: ['cwd'],
  scope: 'project',
  output: 'raw-stream',
  rawStreamReason: 'host-orchestrated-evidence',
  producesEvidenceSnapshot: true,
  handler: (raw, cli) => produceContextInventory(raw as ContextCommandOptions, cli),
});

export const graphContextEnsureCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  staticHandler: {
    package: PACKAGE,
    path: PATH,
    declaration: 'graphContextEnsureCommandSpec',
  },
  name: 'graph-context-ensure',
  visibility: 'internal',
  description: '[internal] Reuse or rebuild one current graph context generation',
  commonFlags: ['cwd'],
  scope: 'project',
  output: 'raw-stream',
  rawStreamReason: 'host-orchestrated-evidence',
  producesEvidenceSnapshot: true,
  handler: (raw, cli) => produceContextGraph(raw as ContextCommandOptions, cli),
});

export const graphContextSelectTestsCommandSpec: CommandSpec<unknown, ToolCliContext> =
  defineCommand<unknown, ToolCliContext>({
    staticHandler: {
      package: PACKAGE,
      path: PATH,
      declaration: 'graphContextSelectTestsCommandSpec',
    },
    name: 'graph-context-select-tests',
    visibility: 'internal',
    description: '[internal] Persist static test-selection context for explicit files',
    commonFlags: ['cwd'],
    options: [FILES_OPTION],
    scope: 'project',
    output: 'raw-stream',
    rawStreamReason: 'host-orchestrated-evidence',
    producesEvidenceSnapshot: true,
    handler: (raw, cli) => produceContextTestSelection(raw as ContextCommandOptions, cli),
  });

export const graphContextCommandSpecs = [
  graphContextInventoryCommandSpec,
  graphContextEnsureCommandSpec,
  graphContextSelectTestsCommandSpec,
] as const;
