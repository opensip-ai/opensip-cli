import { noDbgMacro } from './checks/no-dbg-macro.js'

export const checks = [noDbgMacro] as const

// Display metadata (icons/pretty names) for this pack's checks, surfaced
// through the barrel so the plugin loader's mergeCheckDisplay picks it up.
export { checkDisplay } from './display/index.js'
