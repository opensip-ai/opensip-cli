// CLEAN: common flags come from the shared registry via applyCommonFlags.
import { applyCommonFlags } from '@opensip-cli/contracts'

export function register(program) {
  const cmd = program.command('fit').description('Run fitness checks')
  cmd.option('--recipe <name>', 'Use a named recipe')
  applyCommonFlags(cmd, ['cwd', 'json', 'quiet', 'verbose', 'debug', 'reportTo', 'apiKey'], {
    cwd: process.cwd(),
  })
  cmd.action(() => {})
}
