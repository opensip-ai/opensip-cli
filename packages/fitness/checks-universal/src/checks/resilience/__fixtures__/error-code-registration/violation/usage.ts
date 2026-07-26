export function readTarget(path: string): string {
  // `DEMO.READ.DENIED` is declared in no registry, so a catalog built from the definitions
  // module cannot describe this failure and no consumer can look up what to do about it.
  throw Object.assign(new Error('denied'), { code: 'DEMO.READ.DENIED' })
}
