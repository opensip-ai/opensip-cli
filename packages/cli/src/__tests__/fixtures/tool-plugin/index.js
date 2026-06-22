// Fixture full Tool plugin (audit P1b). A third-party `kind: "tool"`
// package: installed via `opensip plugin add`, discovered by marker,
// and mounted as the `audit-demo` subcommand with no config wiring.
//
// ADR-0054: an EXTERNAL tool's command runs OUT-OF-PROCESS in a forked worker
// (the host never imports the runtime). Raw output therefore crosses the worker
// boundary through the `cli.emitRaw` SEAM — NOT a direct `process.stdout.write`,
// which would land on the worker's (ignored) stdout and never reach the host.
// `metadata.id` is the human key (matches `package.json#opensipTools.id`); no
// display-only `name` divergence (the host synthesizes the registry entry from
// the manifest's `id`, so a mismatched display name would break provenance
// matching).
export const tool = {
  metadata: {
    id: 'audit-demo-tool',
    name: 'audit-demo-tool',
    version: '0.0.0',
    description: 'Fixture tool plugin used by the e2e install-path test',
  },
  commands: [
    { name: 'audit-demo', description: 'Demo audit command contributed by a tool plugin' },
  ],
  // 3.0.0: the one command surface is the declarative commandSpec the host mounts
  // (register() was removed). `raw-stream` output = the handler owns its output
  // surface, emitted via the `cli.emitRaw` seam so it crosses the worker boundary.
  commandSpecs: [
    {
      name: 'audit-demo',
      description: 'Demo audit command contributed by a tool plugin',
      commonFlags: [],
      scope: 'project',
      output: 'raw-stream',
      rawStreamReason: 'lookup',
      handler(_opts, cli) {
        cli.emitRaw('audit-demo ran');
        return {};
      },
    },
  ],
};
