// VIOLATION: --json and --report-to are hand-declared instead of coming from
// the shared registry (applyCommonFlags). This is the drift ADR-0021 forbids.
export function register(program) {
  const cmd = program.command('fit').description('Run fitness checks')
  cmd.option('--recipe <name>', 'Use a named recipe')
  cmd.option('--json', 'Output structured JSON', false)
  cmd.option('--report-to <url>', 'POST findings somewhere slightly different')
  cmd.action(() => {})
}
