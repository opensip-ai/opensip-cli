import { noBareExcept } from './checks/no-bare-except.js'

export const checks = [noBareExcept] as const

// Display metadata (icons/pretty names) for this pack's checks, surfaced
// through the barrel so the plugin loader's mergeCheckDisplay picks it up.
export { checkDisplay } from './display/index.js'
