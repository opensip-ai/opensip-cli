/**
 * commands — orchestrator for the CLI-owned subcommands.
 *
 * Cross-tool housekeeping that doesn't belong to any single tool:
 *
 *   - `init`         — scaffold opensip-tools.config.yml + example tree
 *   - `dashboard`    — compose + open the cross-tool HTML report
 *   - `sessions`     — `list` / `purge`
 *   - `configure`    — set up the OpenSIP Cloud API key
 *   - `plugin`       — `list` / `add` / `remove` / `sync`
 *   - `completion`   — print a shell-completion script
 *   - `uninstall`    — remove user-level / project-local state
 *
 * Each subcommand's option declarations + dispatch live in their own
 * `register-*.ts` file (audit 2026-05-23 M2). This file is a 30-line
 * orchestrator that wires them onto the supplied Commander program.
 *
 * Tool-owned subcommands (`fit`, `sim`, `graph`, …) are mounted
 * separately by walking the CLI-managed tool registry and calling each tool's
 * `register(cli)`.
 */

import { registerCompletion } from './register-completion.js';
import { registerConfigure } from './register-configure.js';
import { registerDashboard } from './register-dashboard.js';
import { registerInit } from './register-init.js';
import { registerPlugins } from './register-plugins.js';
import { registerSessions } from './register-sessions.js';
import { registerUninstall } from './register-uninstall.js';

import type { CliCommandsContext } from './shared.js';
import type { Command } from 'commander';

export type { CliCommandsContext } from './shared.js';

/**
 * Mount the CLI-owned commands onto the supplied Commander program.
 * Pure function — no module-level side effects, no closure over
 * globals — so tests can register commands against a fresh `Command`
 * instance and inspect the resulting subcommand tree.
 */
export function registerCliCommands(program: Command, ctx: CliCommandsContext): void {
  registerInit(program, ctx);
  registerDashboard(program, ctx);
  registerSessions(program, ctx);
  registerConfigure(program, ctx);
  registerPlugins(program, ctx);
  registerCompletion(program, ctx);
  registerUninstall(program, ctx);
}
