/** Descriptor-safe plain-object recognition for hostile boundary input. */
export function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  try {
    if (Array.isArray(value)) return false;
    const prototype = Reflect.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    // @swallow-ok probe/optional capability: hostile prototype inspection fails closed.
    return false;
  }
}
