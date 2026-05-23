/**
 * register-completion — Commander wiring for `opensip-tools completion <shell>`.
 *
 * Split out of `commands/index.ts` per audit 2026-05-23 M2. The
 * completion script itself is generated in `completion.ts`; this file
 * owns only the command surface (option declarations + dispatch).
 */

import { EXIT_CODES } from '@opensip-tools/contracts';

import { printCompletionScript } from './completion.js';
import { type CliCommandsContext } from './shared.js';

import type { Command } from 'commander';

export function registerCompletion(program: Command, ctx: CliCommandsContext): void {
  program
    .command('completion <shell>')
    .description('Print a shell-completion script (bash | zsh | fish)')
    .action((shell: string) => {
      const normalized = shell.toLowerCase();
      if (normalized !== 'bash' && normalized !== 'zsh' && normalized !== 'fish') {
        process.stderr.write(`Unsupported shell: ${shell}. Expected one of: bash, zsh, fish.\n`);
        ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
        return;
      }
      printCompletionScript(normalized);
    });
}
