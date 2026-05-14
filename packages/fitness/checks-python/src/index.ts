import { noBareExcept } from './checks/no-bare-except.js'

export const checks = [noBareExcept] as const


export const metadata = {
  name: '@opensip-tools/checks-python',
  version: '0.6.1',
  description: 'Python fitness checks',
}

export {noBareExcept} from './checks/no-bare-except.js'