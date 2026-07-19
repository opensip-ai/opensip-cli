/** Match a bounded Node-style error code without assuming the thrown value's shape. */
export function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
