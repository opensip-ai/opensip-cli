/**
 * Read an optional `failureClass` tag stamped on a thrown error for worker IPC.
 */
export function getWorkerErrorFailureClass(error: unknown): string | undefined {
  return (error as { failureClass?: string }).failureClass;
}
