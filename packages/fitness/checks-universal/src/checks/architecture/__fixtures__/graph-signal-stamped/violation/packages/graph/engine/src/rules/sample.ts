import { createSignal } from '@opensip-tools/core'
export function build(): unknown {
  return createSignal({ source: 'graph', ruleId: 'graph:sample', severity: 'low', message: 'x' })
}
