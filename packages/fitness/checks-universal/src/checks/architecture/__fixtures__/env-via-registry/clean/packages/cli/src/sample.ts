import { EnvRegistry } from '@opensip-tools/core'
const ENV = new EnvRegistry([{ canonical: 'SAMPLE_FLAG', docs: 'x' }])
export const flag = ENV.get('SAMPLE_FLAG')
// Whole-env passthrough to a child is fine — not a governed read:
export const childEnv = { ...process.env, EXTRA: '1' }
