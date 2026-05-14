import { clangTidyPassthrough } from './checks/clang-tidy-passthrough.js'

export const checks = [clangTidyPassthrough] as const
export { clangTidyPassthrough, parseClangTidyOutput } from './checks/clang-tidy-passthrough.js'

export const metadata = {
  name: '@opensip-tools/checks-cpp',
  version: '0.6.1',
  description: 'C/C++ fitness checks (clang-tidy backed)',
}
