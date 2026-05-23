import { readPackageVersion } from '@opensip-tools/fitness'

import { noPrintStackTrace } from './checks/no-printstacktrace.js'

export const checks = [noPrintStackTrace] as const


export const metadata = {
  name: '@opensip-tools/checks-java',
  version: readPackageVersion(import.meta.url),
  description: 'Java fitness checks',
}

export {noPrintStackTrace} from './checks/no-printstacktrace.js'