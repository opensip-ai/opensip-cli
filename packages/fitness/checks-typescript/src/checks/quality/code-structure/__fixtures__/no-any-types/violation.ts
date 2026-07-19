export function identity(value: any): any {
  return value
}

// No-space formatting variants a formatter would rewrite — the pre-filter
// superset contract means these MUST still be flagged.
export function noSpace(value:any) {
  return value
}

export function tupleForm(pair: [string,any]) {
  return pair
}

export function assertion(value: unknown) {
  return value as any
}
