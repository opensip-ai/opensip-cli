import { noBareExcept } from './checks/no-bare-except.js'

export const checks = [noBareExcept] as const
export { noBareExcept }

export const metadata = {
  name: '@opensip-tools/checks-python',
  version: '0.6.1',
  description: 'Python fitness checks',
}
