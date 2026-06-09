// VIOLATION: a headless worker entry that performs persistence. Off-process
// workers must only compute; persisting a session is parent-only work.
export async function executeWorker(specPath: string, datastore: unknown): Promise<void> {
  const result = await runEngine(specPath)
  persistSession({ cwd: specPath }, result.signals, datastore, result.durationMs)
}
