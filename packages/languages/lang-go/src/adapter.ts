import { parseGo, type GoTree } from './parse.js';
import { stripComments, stripStrings } from './strip.js';

import type { LanguageAdapter } from '@opensip-cli/core';

export const goAdapter: LanguageAdapter<GoTree> = {
  id: 'go',
  fileExtensions: ['.go'],
  aliases: ['golang'],
  parse: parseGo,
  stripStrings,
  stripComments,
};

/** Plugin contract — exported as the lang plugin's `adapters` array. */
export const adapters = [goAdapter] as const;
