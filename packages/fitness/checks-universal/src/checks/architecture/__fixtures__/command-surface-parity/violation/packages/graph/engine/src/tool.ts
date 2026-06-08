// VIOLATION: the tool reaches back to raw Commander — a `cli.program as` cast
// plus `program.command(...)` / `.option(...)` calls, and a `register()` body
// with no `commandSpecs`. This is exactly the escape the 2.11.0 command plane
// closed; the host must own all Commander wiring via mountCommandSpec.
export function register(cli) {
  const program = cli.program as CliProgram
  const cmd = program.command('graph').description('Build the static call graph')
  cmd.option('--resolution <tier>', 'Resolution tier')
  cmd.argument('[paths...]', 'Paths to analyze')
  cmd.action(() => {})
}
