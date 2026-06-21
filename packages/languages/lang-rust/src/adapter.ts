import { parseRust, type RustTree } from './parse.js';
import { rustQuery } from './query.js';
import { stripComments, stripStrings } from './strip.js';

import type { LanguageAdapter } from '@opensip-cli/core';
import type { Node } from '@opensip-cli/tree-sitter';

export const rustAdapter: LanguageAdapter<RustTree, Node> = {
  id: 'rust',
  fileExtensions: ['.rs'],
  aliases: ['rs'],
  parse: parseRust,
  stripStrings,
  stripComments,
  query: rustQuery,
};

/** Plugin contract — exported as the lang plugin's `adapters` array. */
export const adapters = [rustAdapter] as const;
