// @fixture/foundation — the genuine cross-package target.
//
// `canonicalize` is a self-recursive leaf util (mirrors the real-world
// `canonicalize` defect): it calls ITSELF to normalize nested structures.
// The self-edge must survive both single-program and sharded resolution.
//
// A SAME-NAMED `canonicalize` also lives in @fixture/b (b/src/util.ts). That
// collision is the phantom trap: pkg-a imports ONLY this one, so a name-only
// resolver would wrongly link pkg-a -> b.canonicalize. The semantic linker
// must pin the import specifier `@fixture/foundation` to THIS occurrence.

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    // Self-recursive: normalize each element by calling ourselves.
    return value.map((element) => canonicalize(element));
  }
  return value;
}
