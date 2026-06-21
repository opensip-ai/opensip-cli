import { parsePython, type PythonTree } from './parse.js';
import { pythonQuery } from './query.js';
import { stripComments, stripStrings } from './strip.js';

import type { LanguageAdapter } from '@opensip-cli/core';
import type { Node } from '@opensip-cli/tree-sitter';

export const pythonAdapter: LanguageAdapter<PythonTree, Node> = {
  id: 'python',
  fileExtensions: ['.py', '.pyi'],
  aliases: ['py'],
  parse: parsePython,
  stripStrings,
  stripComments,
  query: pythonQuery,
};

/** Plugin contract — exported as the lang plugin's `adapters` array. */
export const adapters = [pythonAdapter] as const;
