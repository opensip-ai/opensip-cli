/**
 * Read an optional `failureClass` tag stamped on a thrown error for worker IPC.
 */
export function getWorkerErrorFailureClass(error: unknown): string | undefined {
  // Guard the property access: the thrown value is `unknown`, so a nullish
  // throw (`throw null` / `Promise.reject()`) would otherwise raise a TypeError
  // here, escape the caller's catch, and suppress the worker's error IPC —
  // losing the real failure. Mirrors the `instanceof Error` robustness the
  // sibling `toWorkerErrorMessage` already applies to arbitrary throws.
  if (typeof error !== 'object' || error === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'failureClass');
    return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value.slice(0, 128)
      : undefined;
  } catch {
    // @swallow-ok probe/optional capability: hostile descriptors carry no trusted failure-class tag.
    return undefined;
  }
}
