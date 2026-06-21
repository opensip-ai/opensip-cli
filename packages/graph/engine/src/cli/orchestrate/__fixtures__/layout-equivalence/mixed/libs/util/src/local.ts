// @eq/util — an intra-package helper imported via a RELATIVE specifier.
// The edge helpFmt -> localPad must path-pin to THIS file: a relative import
// resolves against the owner's directory, never a package export table.

export function localPad(value: unknown): string {
  return String(value);
}
