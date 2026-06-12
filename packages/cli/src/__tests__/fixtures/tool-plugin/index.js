// Fixture full Tool plugin (audit P1b). A third-party `kind: "tool"`
// package: installed via `opensip plugin add`, discovered by marker,
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
  // 3.0.0: the one command surface is the declarative commandSpec the host mounts
  // (register() was removed). `raw-stream` output = the handler owns its stdout.
  commandSpecs: [
    {
      name: 'audit-demo',
      description: 'Demo audit command contributed by a tool plugin',
      commonFlags: [],
      scope: 'project',
      output: 'raw-stream',
      handler() {
        process.stdout.write('audit-demo ran\n');
        return {};
      },
    },
  ],
};
