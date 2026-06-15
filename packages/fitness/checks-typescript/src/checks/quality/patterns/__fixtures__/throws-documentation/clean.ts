/**
 * Divide two numbers.
 * @throws {Error} When the divisor is zero.
 */
export function divide(a: number, b: number): number {
  if (b === 0) {
    throw new Error('division by zero')
  }
  return a / b
}
