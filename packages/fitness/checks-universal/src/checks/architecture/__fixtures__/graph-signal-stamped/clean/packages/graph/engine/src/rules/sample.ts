import { createGraphSignal } from './create-graph-signal.js'
export function build(config: unknown): unknown {
  return createGraphSignal('graph:sample', config as never, { severity: 'low', category: 'quality', message: 'x' })
}
