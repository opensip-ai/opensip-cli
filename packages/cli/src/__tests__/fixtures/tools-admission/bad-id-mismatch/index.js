// Fixture: runtime tool id differs from the manifest id — the
// manifest-runtime-coherence drift guard must reject it.
export const tool = {
  metadata: { id: 'runtime-id', name: 'Mismatch', version: '0.0.0', description: 'fixture' },
  commands: [{ name: 'mismatch-cmd', description: 'noop' }],
  commandSpecs: [
    {
      name: 'mismatch-cmd',
      description: 'noop',
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
