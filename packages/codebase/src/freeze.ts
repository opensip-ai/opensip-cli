/**
 * Deep-freeze JSON-like evidence facts. Maps are kept private behind ReadonlyMap views.
 *
 * The parent is frozen BEFORE its children are walked. That ordering is what makes the
 * helper total: `Object.isFrozen` is then the cycle cut, so a self-referential graph
 * terminates instead of recursing until the stack overflows. Freezing is shallow, so
 * freezing first changes nothing about the result.
 *
 * This helper deliberately does not throw on a cycle. It is the last step of the
 * degradation paths it hardens (the empty/last-resort inventory snapshot runs through
 * it), and a hardening step that can fail is a failure path that can fail.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/** Locale-independent ordering used by every persisted inventory projection. */
export function byCodePoint(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]?.codePointAt(0) ?? 0;
    const rightPoint = rightPoints[index]?.codePointAt(0) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
}
