// @fixture/b — the phantom-trap decoy.
//
// This package ALSO exports a function named `canonicalize`. pkg-a never
// imports @fixture/b, so the CORRECT graph has NO edge pkg-a -> b.canonicalize.
// A name-only resolver (the old syntactic fallback) would match the globally
// non-unique simple name `canonicalize` into this package and fabricate that
// phantom cross-package edge. The equivalence gate exists to catch exactly
// that regression.

export function canonicalize(value: unknown): unknown {
  return value;
}
