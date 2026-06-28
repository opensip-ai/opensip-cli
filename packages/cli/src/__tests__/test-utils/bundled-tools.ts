/**
 * Test-only helper: the bundled tool RUNTIMES, in registration order.
 *
 * 3.0.0 GA: production no longer statically imports fit/graph/sim — the host
 * loads them by DYNAMIC IMPORT through `BUNDLED_TOOL_PACKAGES`
 * (`bootstrap/register-tools.ts`), so install-source independence is structural.
 * White-box tests that need the actual tool instances (command-surface
 * snapshots, flag-parity sweeps, ordering assertions) import them directly here
 * — legitimate because this file lives under `__tests__/`, which the
 * `no-bootstrap-tool-import` guardrail exempts (the regression it guards is a
 * static tool-runtime import in *host* code, not test code).
 *
 * Not a test file (no `.test.` suffix) — vitest's test-glob matches only
 * `.test.ts`, so it skips this; the cli tsconfig + coverage both exclude
 * `__tests__`; and `test-file-naming` skips the `test-utils` directory.
 */
import { fitnessTool } from '@opensip-cli/fitness';
import { graphTool } from '@opensip-cli/graph';
import { mcpTool } from '@opensip-cli/mcp';
import { simulationTool } from '@opensip-cli/simulation';
import { yagniTool } from '@opensip-cli/yagni';

import type { Tool } from '@opensip-cli/core';

/** The bundled tool runtimes, in registration (and thus help/listing) order. */
export const BUNDLED_TOOLS: readonly Tool[] = [
  fitnessTool,
  simulationTool,
  graphTool,
  yagniTool,
  mcpTool,
];

/**
 * The bundled tool ids (human keys = `metadata.name` = `identity.name`), in
 * registration order — the discovery skip-set. Canonical names are the full tool
 * verbs (`fitness`/`simulation`/`graph`/`yagni`/`mcp`); short forms are CLI aliases.
 */
export const BUNDLED_TOOL_IDS: readonly string[] = [
  'fitness',
  'simulation',
  'graph',
  'yagni',
  'mcp',
];
