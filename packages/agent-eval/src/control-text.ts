/**
 * Shared control-character guard for untrusted string inputs (CLI arguments and
 * candidate entrypoint paths). Rejects C0 control characters and DEL, matching
 * the historical validation both callers used before it was deduplicated.
 */
export function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
}
