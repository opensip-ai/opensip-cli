import { definitions } from './definitions.js'

export function readTarget(path: string): string {
  if (path.length === 0) {
    throw new Error(definitions['DEMO.CONFIG.INVALID'].operatorAction)
  }
  // A registered code used by literal: the registry above declares it.
  throw Object.assign(new Error('denied'), { code: 'DEMO.READ.DENIED' })
}
