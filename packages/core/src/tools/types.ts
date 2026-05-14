/**
 * Tool plugin contract.
 *
 * A Tool is a self-contained capability (fitness, simulation, future
 * audit/lint/etc.) that contributes one or more CLI subcommands. The
 * CLI is a generic dispatcher that walks the registered tool list and
 * builds its command tree from each tool's `commands` array.
 *
 * Tools are first-party (declared as a direct dep of @opensip-tools/cli)
 * or third-party (any npm package whose package.json declares
 * `opensipTools.kind === 'tool'` — discovered via tool-package-discovery).
 *
 * Parallel to the kernel's plugin model:
 *   - plugins/types.ts — file-level plugin entries (one .mjs per file)
 *   - tools/types.ts   — package-level tool entries (one Tool per pkg)
 */

import type { logger as coreLogger } from '../lib/logger.js';

export interface ToolMetadata {
  /** Stable identifier — e.g. 'fitness', 'simulation'. */
  readonly id: string;
  readonly version: string;
  readonly description: string;
}

export interface ToolRunContext {
  /** Project directory the user is running against. */
  readonly cwd: string;
  /** Explicit --config path, if the user supplied one. */
  readonly configPath?: string;
  /** Shared logger — write structured events here, not directly to stderr. */
  readonly logger: typeof coreLogger;
}

export interface ToolRunResult {
  readonly exitCode: number;
  /** Optional structured output for --json. */
  readonly output?: unknown;
}

export interface ToolCommand {
  /** CLI subcommand name — 'fit', 'sim', 'fit-list', etc. */
  readonly name: string;
  readonly description: string;
  readonly aliases?: readonly string[];
  /** Hand off argv (post-flags-split) to the tool's implementation. */
  readonly run: (
    argv: readonly string[],
    ctx: ToolRunContext,
  ) => Promise<ToolRunResult>;
}

export interface Tool {
  readonly metadata: ToolMetadata;
  readonly commands: readonly ToolCommand[];
  /**
   * Optional one-time initialization. Called by the CLI before any of
   * the tool's commands run. Use it to register sub-packages (check
   * packs, scenario packs), language adapters, etc.
   *
   * The CLI calls initialize() at most once per process. Subsequent
   * commands skip it.
   */
  readonly initialize?: (ctx: ToolRunContext) => Promise<void>;
}

/**
 * Plugin export shape for npm packages whose package.json declares
 * `opensipTools.kind === 'tool'`. The package's main entry must export
 * a `tool` symbol of this shape.
 */
export interface ToolPluginExports {
  readonly tool: Tool;
}
