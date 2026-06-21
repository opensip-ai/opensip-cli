// @eq/core — the leaf package.
//
// `baseValue` is a self-recursive leaf util: it calls ITSELF to normalize
// nested input. The self-edge must survive in every layout.
//
// A SAME-NAMED `baseValue` decoy also lives in @eq/app (app/src/run.ts). That
// collision is the phantom trap: @eq/util imports ONLY this one, so a name-only
// resolver would wrongly link util.helpFmt -> app.baseValue. The semantic
// linker must pin the `@eq/core` specifier to THIS occurrence.

export function baseValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const head = value[0];
    return baseValue(head);
  }
  return value;
}
