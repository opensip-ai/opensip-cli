// A registry that matches NEITHER the filename patterns NOR a catalog-builder call: it only
// exports a definitions object. Recognised by declaration SHAPE — each code appears as a
// property key AND as that entry's `code` value. This is the split-registry case, where the
// builder call lives in a sibling module.
export const definitions = {
  'DEMO.CONFIG.INVALID': {
    code: 'DEMO.CONFIG.INVALID',
    operatorAction: 'Correct the named configuration field.',
  },
  'DEMO.READ.DENIED': {
    code: 'DEMO.READ.DENIED',
    operatorAction: 'Grant read access to the target path.',
  },
} as const
