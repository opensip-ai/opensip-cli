import { readPackageVersion } from '@opensip-tools/fitness'

import { noDbgMacro } from './checks/no-dbg-macro.js'

export const checks = [noDbgMacro] as const

export const metadata = {
  name: '@opensip-tools/checks-rust',
  version: readPackageVersion(import.meta.url),
  description: 'Rust fitness checks',
}
