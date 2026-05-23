import { readPackageVersion } from '@opensip-tools/fitness'

import { noBareExcept } from './checks/no-bare-except.js'

export const checks = [noBareExcept] as const


export const metadata = {
  name: '@opensip-tools/checks-python',
  version: readPackageVersion(import.meta.url),
  description: 'Python fitness checks',
}

export {noBareExcept} from './checks/no-bare-except.js'