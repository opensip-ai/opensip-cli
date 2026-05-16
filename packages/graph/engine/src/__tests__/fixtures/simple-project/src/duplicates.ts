// Two functions with identical bodies — duplicated-function-body rule fires.

export function add(a: number, b: number): number {
  return a + b;
}

export function plus(a: number, b: number): number {
  return a + b;
}
