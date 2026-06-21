import { parseGo, type GoTree } from './parse.js';
import { goQuery } from './query.js';
import { stripComments, stripStrings } from './strip.js';

import type { LanguageAdapter } from '@opensip-cli/core';
import type { Node } from '@opensip-cli/tree-sitter';

export const goAdapter: LanguageAdapter<GoTree, Node> = {
  id: 'go',
  fileExtensions: ['.go'],
  aliases: ['golang'],
  parse: parseGo,
  stripStrings,
  stripComments,
  query: goQuery,
};

/** Plugin contract — exported as the lang plugin's `adapters` array. */
export const adapters = [goAdapter] as const;
