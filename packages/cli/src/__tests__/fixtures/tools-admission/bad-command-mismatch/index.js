// Fixture: manifest declares `declared-cmd`; the runtime exports a DIFFERENT
// command name — the coherence drift guard must reject it.
export const tool = {
  identity: { name: 'command-mismatch-tool' },
  metadata: {
    id: 'command-mismatch-tool',
    name: 'command-mismatch-tool',
    version: '0.0.0',
    description: 'fixture',
  },
  commands: [{ name: 'other-cmd', description: 'not the declared one' }],
  commandSpecs: [
    {
      name: 'command-mismatch-tool',
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
