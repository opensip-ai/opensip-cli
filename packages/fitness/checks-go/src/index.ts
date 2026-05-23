import { readPackageVersion } from '@opensip-tools/fitness'

import { noFmtPrint } from './checks/no-fmt-print.js'

export const checks = [noFmtPrint] as const

export const metadata = {
  name: '@opensip-tools/checks-go',
  version: readPackageVersion(import.meta.url),
  description: 'Go fitness checks',
}
