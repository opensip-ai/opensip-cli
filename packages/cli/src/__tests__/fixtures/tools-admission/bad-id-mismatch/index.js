// Fixture: runtime tool id differs from the manifest id — the
// manifest-runtime-coherence drift guard must reject it.
export const tool = {
  identity: { name: 'runtime-id' },
  metadata: { id: 'runtime-id', name: 'runtime-id', version: '0.0.0', description: 'fixture' },
  commands: [{ name: 'runtime-id', description: 'noop' }],
  commandSpecs: [
    {
      name: 'runtime-id',
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
