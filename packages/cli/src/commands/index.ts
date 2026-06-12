/**
 * commands — orchestrator for the CLI-owned (host) subcommands.
 *
 * Cross-tool housekeeping that doesn't belong to any single tool:
 *
 *   - `init`         — scaffold opensip-cli.config.yml + example tree
 *   - `report`       — compose + open the cross-tool HTML report
 *   - `sessions`     — `list` / `purge`
 *   - `configure`    — set up the OpenSIP Cloud API key
 *   - `plugin`       — `list` / `add` / `remove` / `sync`
 *   - `completion`   — print a shell-completion script
 *   - `uninstall`    — remove user-level / project-local state
 *
 * Release 2.11.0 Phase 6: every host command is now a declarative
 * `CommandSpec` mounted through the SAME `mountCommandSpec` plane the tools
 * use (`host-command-specs.ts`). The former per-command `register-*.ts`
 * registrars (hand-rolled `.command().option().action()` bodies) are gone —
 * host and tool commands share ONE mounting path, so the Phase 7
 * `command-surface-parity` guardrail sees a single uniform surface with no
 * two-tier privilege.
 *
 * Tool-owned subcommands (`fit`, `sim`, `graph`, …) are mounted separately by
 * walking the CLI-managed tool registry (`mountToolCommands`), which mounts
 * each tool's `commandSpecs` via the same `mountCommandSpec`.
 */

import { mountHostCommands } from './host-command-specs.js';

import type { CliCommandsContext } from './shared.js';
import type { Command } from 'commander';

export type { CliCommandsContext } from './shared.js';

/**
 * Mount the CLI-owned host commands onto the supplied Commander program.
 * Pure function — no module-level side effects, no closure over globals — so
 * tests can register commands against a fresh `Command` instance and inspect
 * the resulting subcommand tree.
 */
export function registerCliCommands(program: Command, ctx: CliCommandsContext): void {
  mountHostCommands(program, ctx);
}
