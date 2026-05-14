import { noPrintStackTrace } from './checks/no-printstacktrace.js'

export const checks = [noPrintStackTrace] as const


export const metadata = {
  name: '@opensip-tools/checks-java',
  version: '0.6.1',
  description: 'Java fitness checks',
}

export {noPrintStackTrace} from './checks/no-printstacktrace.js'