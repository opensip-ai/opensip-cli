// Fixture full Tool plugin (audit P1b). A third-party `kind: "tool"`
// package: installed via `opensip-tools plugin add`, discovered by marker,
// and mounted as the `audit-demo` subcommand with no config wiring.
export const tool = {
  metadata: {
    id: 'audit-demo-tool',
    name: 'Audit Demo',
    version: '0.0.0',
    description: 'Fixture tool plugin used by the e2e install-path test',
  },
  commands: [
    { name: 'audit-demo', description: 'Demo audit command contributed by a tool plugin' },
  ],
  register(cli) {
    cli.program
      .command('audit-demo')
      .description('Demo audit command contributed by a tool plugin')
      .action(() => {
        process.stdout.write('audit-demo ran\n');
      });
  },
};
