import { stripComments, stripStrings } from './strip.js'

import type { LanguageAdapter } from '@opensip-tools/core/languages/adapter.js'


/**
 * C/C++ adapter. parse() returns null intentionally — for C/C++ we
 * rely on external tools (clang-tidy) for AST analysis. Checks targeting
 * C/C++ files use the CommandConfig pattern in @opensip-tools/checks-cpp.
 *
 * stripStrings/stripComments are still useful for regex-based checks
 * that want to ignore string/comment content.
 */
export const cppAdapter: LanguageAdapter<null> = {
  id: 'cpp',
  fileExtensions: ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h', '.c'],
  aliases: ['c', 'c++'],
  parse: () => null,
  stripStrings,
  stripComments,
}

export const adapters = [cppAdapter] as const
