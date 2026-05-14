import { noPrintStackTrace } from './checks/no-printstacktrace.js'

export const checks = [noPrintStackTrace] as const
export { noPrintStackTrace }

export const metadata = {
  name: '@opensip-tools/checks-java',
  version: '0.6.1',
  description: 'Java fitness checks',
}
