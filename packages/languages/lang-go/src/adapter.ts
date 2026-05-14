import type { LanguageAdapter } from '@opensip-tools/core/languages/adapter.js'

import { parseGo, type GoTree } from './parse.js'
import { stripComments, stripStrings } from './strip.js'

export const goAdapter: LanguageAdapter<GoTree> = {
  id: 'go',
  fileExtensions: ['.go'],
  aliases: ['golang'],
  parse: parseGo,
  stripStrings,
  stripComments,
}

/** Plugin contract — exported as the lang plugin's `adapters` array. */
export const adapters = [goAdapter] as const
