// @medium/util — a relative-import target (the pinBySpecifier path).
// utilFormat resolves `./helpers.utilHelper` against its own directory, never
// against a package export table.

export function utilHelper(value: unknown): unknown {
  return value;
}
