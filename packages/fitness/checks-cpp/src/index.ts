import { clangTidyPassthrough } from './checks/clang-tidy-passthrough.js'

export const checks = [clangTidyPassthrough] as const
