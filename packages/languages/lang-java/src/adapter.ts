import { parseJava, type JavaTree } from './parse.js';
import { javaQuery } from './query.js';
import { stripComments, stripStrings } from './strip.js';

import type { LanguageAdapter } from '@opensip-cli/core';
import type { Node } from '@opensip-cli/tree-sitter';

export const javaAdapter: LanguageAdapter<JavaTree, Node> = {
  id: 'java',
  fileExtensions: ['.java'],
  parse: parseJava,
  stripStrings,
  stripComments,
  query: javaQuery,
};

/** Plugin contract — exported as the lang plugin's `adapters` array. */
export const adapters = [javaAdapter] as const;
