// @fixture/a — an intra-package helper imported via a RELATIVE specifier.
// The edge main -> formatLocal must path-pin to THIS file (the pinBySpecifier
// regression case): a relative import resolves against the owner's directory,
// never against a package export table.

export function formatLocal(value: unknown): string {
  return String(value);
}
