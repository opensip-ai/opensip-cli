/**
 * Read an optional `failureClass` tag stamped on a thrown error for worker IPC.
 */
export function getWorkerErrorFailureClass(error: unknown): string | undefined {
  // Guard the property access: the thrown value is `unknown`, so a nullish
  // throw (`throw null` / `Promise.reject()`) would otherwise raise a TypeError
  // here, escape the caller's catch, and suppress the worker's error IPC —
  // losing the real failure. Mirrors the `instanceof Error` robustness the
  // sibling `toWorkerErrorMessage` already applies to arbitrary throws.
  return typeof error === 'object' && error !== null
    ? (error as { failureClass?: string }).failureClass
    : undefined;
}
