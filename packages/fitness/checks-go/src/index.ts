import { noFmtPrint } from './checks/no-fmt-print.js'

export const checks = [noFmtPrint] as const

// Display metadata (icons/pretty names) for this pack's checks, surfaced
// through the barrel so the plugin loader's mergeCheckDisplay picks it up.
export { checkDisplay } from './display/index.js'
