/**
 * Locale-independent string ordering used by the persisted codebase inventory.
 *
 * Keep this implementation byte-for-byte equivalent in behavior to
 * `packages/codebase/src/freeze.ts#byCodePoint`: JavaScript's default string
 * comparison orders UTF-16 code units, which puts some astral characters
 * before lower-valued BMP characters.
 */
export function compareCodePointStrings(left: string, right: string): number {
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
