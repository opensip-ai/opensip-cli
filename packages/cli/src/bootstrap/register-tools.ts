/**
 * register-tools — populate the kernel `ToolRegistry` with first-party
 * tools (fitness / simulation / graph) plus any third-party tool
 * packages discovered on disk.
 *
 * Extracted from `index.ts`. The bundled-id skip below is defense in
 * depth: as of Layer 1 Phase 1 the registry itself enforces
 * first-writer-wins on duplicate ids and logs a structured
 * `tool.registry.duplicate` warning. Keeping the explicit guard avoids
 * a noisy warning when a third-party package happens to ship under a
 * built-in id.
 */

import {
  discoverToolPackages,
  logger,
  type Tool,
  type ToolCliContext,
  type ToolRegistry,
} from '@opensip-tools/core';
import { fitnessTool } from '@opensip-tools/fitness';
import { graphTool } from '@opensip-tools/graph';
import { simulationTool } from '@opensip-tools/simulation';

/** First-party tools — declared as direct deps of @opensip-tools/cli. */
export const FIRST_PARTY_TOOLS: readonly Tool[] = [
  fitnessTool,
  simulationTool,
  graphTool,
];

/** Register first-party tools into the supplied registry. */
export function registerFirstPartyTools(registry: ToolRegistry): void {
  for (const tool of FIRST_PARTY_TOOLS) {
    registry.register(tool);
  }
}

export interface DiscoveryOptions {
  /** Project directory used to seed `node_modules` walks. */
  readonly projectDir: string;
}

/**
 * Discover and register third-party tool packages from npm — any
 * `package.json` declaring `opensipTools.kind === 'tool'`. Built-in
 * ids are skipped to avoid double-registration warnings.
 */
export async function discoverAndRegisterToolPackages(
  registry: ToolRegistry,
  opts: DiscoveryOptions,
): Promise<void> {
  const builtInIds = new Set(FIRST_PARTY_TOOLS.map((t) => t.metadata.id));
  const discovered = discoverToolPackages({ projectDir: opts.projectDir });

  for (const pkg of discovered) {
    try {
      const mod = (await import(pkg.name)) as { tool?: unknown };
      // Runtime shape validation: a third-party tool is an untrusted
      // boundary. Validate the exported `tool` symbol's shape before
      // touching it, matching the pattern used by
      // `register-graph-adapters.ts`. A malformed package gets a clear
      // stderr line + structured warning and is skipped — better than
      // a TypeError mid-registration or a silently-broken Tool slot.
      if (!isValidTool(mod.tool)) {
        process.stderr.write(
          `opensip-tools: tool package ${pkg.name} does not export a valid \`tool\` — skipping\n`,
        );
        logger.warn({
          evt: 'cli.tool.invalid_shape',
          module: 'cli:bootstrap',
          name: pkg.name,
        });
        continue;
      }
      if (builtInIds.has(mod.tool.metadata.id)) continue;
      registry.registerThirdParty(mod.tool, { sourcePackage: pkg.name });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`opensip-tools: failed to load tool ${pkg.name}: ${msg}\n`);
      logger.warn({
        evt: 'cli.tool.load_failed',
        module: 'cli:bootstrap',
        name: pkg.name,
        error: msg,
      });
    }
  }
}

/**
 * Runtime shape predicate for third-party tool exports. Verifies the
 * minimal contract the registry depends on: a `metadata.id` string
 * (used for dedupe + listing) and the two required methods
 * (`register`, `commands` — `initialize` and `extendScope` stay
 * optional per the Tool interface).
 */
function isValidTool(value: unknown): value is Tool {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { metadata?: unknown; register?: unknown; commands?: unknown };
  if (typeof candidate.metadata !== 'object' || candidate.metadata === null) return false;
  if (typeof (candidate.metadata as { id?: unknown }).id !== 'string') return false;
  if (typeof candidate.register !== 'function') return false;
  if (!Array.isArray(candidate.commands)) return false;
  return true;
}

/**
 * Walk the registry and ask each tool to mount its Commander
 * subcommands via `tool.register(cli)`. Failures are isolated so one
 * misbehaving tool doesn't take the whole CLI down — the failure is
 * logged and stderr-warned, then we continue.
 */
export function mountAllToolCommands(registry: ToolRegistry, ctx: ToolCliContext): void {
  for (const tool of registry.list()) {
    try {
      tool.register(ctx);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`opensip-tools: tool ${tool.metadata.id} failed to register: ${msg}\n`);
      logger.warn({
        evt: 'cli.tool.register_failed',
        module: 'cli:bootstrap',
        toolId: tool.metadata.id,
        error: msg,
      });
    }
  }
}
