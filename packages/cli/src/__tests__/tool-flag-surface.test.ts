/**
 * Capability guard (Tier-2): lock the registered flag surface of every
 * first-party tool. A flag added or removed from any command — across all of
 * fit / graph / sim's subcommands — must be a deliberate change to the
 * expected set here, so the CLI's promised surface can't drift undocumented.
 *
 * This is the cross-tool counterpart to the sim-specific capability test; it
 * derives flags directly from the declarative `CommandSpec`s, so it needs no
 * commander dependency and never invokes a command action.
 */

import { commonFlags } from '@opensip-cli/contracts';
import { describe, expect, it } from 'vitest';

import { BUNDLED_TOOLS } from './test-utils/bundled-tools.js';

import type { Tool } from '@opensip-cli/core';

/**
 * Derive a tool's long-flag set from its `CommandSpec`s: the ADR-0021
 * `commonFlags` keys mapped to their registry `--long` strings, plus each
 * tool-specific `OptionSpec.flag`.
 */
function recordSpecFlags(tool: Tool): string[] {
  const flags = new Set<string>();
  for (const spec of tool.commandSpecs ?? []) {
    for (const key of spec.commonFlags) {
      const match = /--[a-z][a-z-]*/.exec(commonFlags[key].flags);
      if (match) flags.add(match[0]);
    }
    for (const opt of spec.options ?? []) {
      const match = /--[a-z][a-z-]*/.exec(opt.flag);
      if (match) flags.add(match[0]);
    }
  }
  return [...flags].sort();
}

// The locked flag surface per tool (union across all of each tool's
// subcommands). Adding/removing a flag is a deliberate edit here.
const EXPECTED: Record<string, string[]> = {
  // Keyed by tool.metadata.name (= identity.name — canonical CLI verb).
  fitness: [
    // The flag set is the union across all of fit's subcommands. The canonical
    // `fit export --format baseline` command contributes `--format` (choices:
    // baseline) and `--out` (the SARIF baseline path). The legacy flat-root
    // `fit-baseline-export` alias was removed — its flags live on `fit export`.
    '--api-key',
    '--check',
    '--config',
    '--cwd',
    '--debug',
    '--exclude',
    '--format',
    '--gate-compare',
    '--gate-save',
    '--json',
    '--list',
    '--open',
    '--out',
    '--quiet',
    '--recipe',
    '--recipes',
    '--report-to',
    '--show',
    '--tags',
    '--verbose',
    '--filter',
    '--top',
    '--raw',
    '--changed',
    '--since',
    '--include-impacted',
  ],
  graph: [
    // ADR-0011 (Phase 5): graph gained --api-key for --report-to cloud egress.
    // ADR-0021: graph gained -q/--quiet for cross-tool flag parity.
    // Post-2.7.0: graph gained --sarif (real SARIF 2.1.0 for Code Scanning via
    // the shared cli.writeSarif seam).
    //
    // The flag set is the union across all of graph's subcommands. The canonical
    // `graph export --format sarif|catalog|baseline` command contributes the
    // export flags — `--catalog-output`, `--git-sha`, `--output-sarif`,
    // `--repo-id`, `--tenant-id`, `--mode`, `--changed-file`, `--run-id`,
    // `--out`, `--format`. The legacy flat-root `catalog-export` / `sarif-export`
    // / `graph-baseline-export` aliases were removed — their flags live on
    // `graph export`.
    //
    // graph-equivalence-check (internal real-repo sharded≡exact guardrail) adds
    // `--budget` (committed budget path) and `--update-budget` (capture/tighten).
    '--api-key',
    '--budget',
    // `graph index` gained `--build` (build/persist the symbol index) in the
    // tool-command taxonomy work.
    '--build',
    '--catalog-output',
    '--changed-file',
    '--changed',
    '--concurrency',
    '--cwd',
    '--debug',
    '--exact',
    '--files',
    '--filter',
    '--format',
    '--gate-compare',
    '--gate-save',
    '--git-sha',
    '--json',
    '--language',
    '--list-files',
    '--mode',
    '--no-cache',
    '--open',
    '--out',
    '--output-sarif',
    '--profile',
    '--quiet',
    '--raw',
    '--recipe',
    '--repo-id',
    '--report-to',
    '--resolution',
    '--run-id',
    '--sarif',
    '--show',
    '--since',
    '--tenant-id',
    '--top',
    '--update-budget',
    '--verbose',
    '--workspace',
  ],
  // ADR-0011 (Phase 4): sim gained --report-to / --api-key cloud egress.
  // ADR-0021: sim gained -v/--verbose (cross-tool flag parity).
  simulation: [
    '--api-key',
    '--cwd',
    '--debug',
    '--json',
    '--open',
    '--quiet',
    '--recipe',
    '--report-to',
    '--show',
    '--verbose',
    '--filter',
    '--top',
    '--raw',
  ],
  yagni: [
    '--api-key',
    '--category',
    '--cwd',
    '--debug',
    '--detector',
    '--filter',
    '--gate-compare',
    '--gate-save',
    '--include-tests',
    '--json',
    '--min-confidence',
    '--open',
    '--quiet',
    '--raw',
    '--report-to',
    '--sarif',
    '--top',
    '--verbose',
  ],
  // ADR-0084: the `mcp` command is a long-lived stdio JSON-RPC server
  // (output: 'raw-stream'). Its only flag is the shared `--cwd`.
  mcp: ['--cwd'],
};

describe('first-party tool flag-surface contract', () => {
  for (const tool of BUNDLED_TOOLS) {
    const human = tool.metadata.name ?? tool.metadata.id;
    it(`${human}: registers exactly its documented flag set`, () => {
      const expected = EXPECTED[human];
      expect(expected, `no expected flag set for tool '${human}'`).toBeDefined();
      expect(recordSpecFlags(tool)).toEqual([...expected].sort());
    });
  }
});
