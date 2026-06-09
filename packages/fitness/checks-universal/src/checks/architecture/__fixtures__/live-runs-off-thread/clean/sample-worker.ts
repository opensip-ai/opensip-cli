// CLEAN: a headless worker entry that only COMPUTES. It may read the scope
// datastore for an in-build cache, but it never persists a session — that is
// the parent's job, after the run.
export async function executeWorker(specPath: string, cli: { scope: { datastore(): unknown } }): Promise<void> {
  const datastore = cli.scope.datastore()
  const result = await runEngine(specPath, datastore)
  send({ kind: 'result', value: result })
}
