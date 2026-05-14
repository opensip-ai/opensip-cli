import type { LanguageAdapter } from '@opensip-tools/core/languages/adapter.js'

import { parseJava, type JavaTree } from './parse.js'
import { stripComments, stripStrings } from './strip.js'

export const javaAdapter: LanguageAdapter<JavaTree> = {
  id: 'java',
  fileExtensions: ['.java'],
  parse: parseJava,
  stripStrings,
  stripComments,
}

/** Plugin contract — exported as the lang plugin's `adapters` array. */
export const adapters = [javaAdapter] as const
