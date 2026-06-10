import { stripComments, stripStrings } from './strip.js';

import type { LanguageAdapter } from '@opensip-tools/core';

/**
 * C/C++ adapter. parse() returns null intentionally — for C/C++ we
 * rely on external tools (clang-tidy) for AST analysis. Checks targeting
 * C/C++ files use the CommandConfig pattern in @opensip-tools/checks-cpp.
 *
 * stripStrings/stripComments are still useful for regex-based checks
 * that want to ignore string/comment content.
 *
 * Aliases note: `cpp` is the canonical id; `c` is the convenience
 * alias (covers C-only files via `.c` / `.h` extensions). The unquoted
 * `c++` form is omitted from the alias list because it is a YAML
 * quoting footgun — users who write `languages: [c++]` unquoted hit a
 * parser error, while `languages: [cpp]` and `languages: [c]` always
 * round-trip cleanly.
 */
export const cppAdapter: LanguageAdapter<null> = {
  id: 'cpp',
  fileExtensions: ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h', '.c'],
  aliases: ['c'],
  parse: () => null,
  stripStrings,
  stripComments,
};

export const adapters = [cppAdapter] as const;
