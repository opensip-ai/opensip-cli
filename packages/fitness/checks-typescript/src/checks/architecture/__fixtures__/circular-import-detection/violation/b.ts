import { a } from './a.js'

export function b(): number {
  return a === undefined ? 0 : 1
}
