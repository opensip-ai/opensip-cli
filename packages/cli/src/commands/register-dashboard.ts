/**
 * register-dashboard — Commander wiring for `opensip-tools dashboard`.
 *
 * Audit 2026-05-29 (L2): the cross-tool `dashboard` command is now
 * CLI-owned, not fitness-owned. Composition needs the tool REGISTRY
 * (`RunScope.tools`), which the tool-facing `ToolScope` excludes, so the
 * command lives at the CLI layer where `currentScope()` resolves to a
 * `RunScope`. The command delegates to `composeAndWriteDashboard`, which
 * walks every tool's `collectDashboardData` contribution, renders the
 * HTML, writes `<reportsDir>/latest.html`, and opens the browser.
 */

import { composeAndWriteDashboard } from '../dashboard-compose.js';

import { mountResultCommand } from './mount-result-command.js';
import { JSON_DESC, type CliCommandsContext } from './shared.js';

import type { Command } from 'commander';

export function registerDashboard(program: Command, ctx: CliCommandsContext): void {
  const dashboardCmd = program
    .command('dashboard')
    .description('Generate the cross-tool HTML report and open it in your browser')
    .option('--no-open', 'Write the report but do not launch a browser')
    .option('--json', JSON_DESC, false);

  mountResultCommand<{ open: boolean; json: boolean }>(
    dashboardCmd,
    // Commander stores `--no-open` as `opts.open === false`; default true.
    // In `--json` mode we never launch a browser (machine-output contract).
    (opts) => composeAndWriteDashboard({ open: opts.open && !opts.json }),
    { ctx, jsonFlag: (opts) => opts.json },
  );
}
