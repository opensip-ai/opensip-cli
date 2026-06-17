// Fixture: manifest declares `declared-cmd`; the runtime exports a DIFFERENT
// command name — the coherence drift guard must reject it.
export const tool = {
  metadata: {
    id: 'command-mismatch-tool',
    name: 'CmdMismatch',
    version: '0.0.0',
    description: 'fixture',
  },
  commands: [{ name: 'other-cmd', description: 'not the declared one' }],
  commandSpecs: [
    {
      name: 'other-cmd',
      description: 'not the declared one',
      commonFlags: [],
      scope: 'project',
      output: 'raw-stream',
      rawStreamReason: 'diagnostic-gate',
      flags: [],
      handler: () => Promise.resolve(),
    },
  ],
  apiVersion: 1,
};
