import { noFmtPrint } from './checks/no-fmt-print.js'

export const checks = [noFmtPrint] as const


export const metadata = {
  name: '@opensip-tools/checks-go',
  version: '0.6.1',
  description: 'Go fitness checks',
}

export {noFmtPrint} from './checks/no-fmt-print.js'