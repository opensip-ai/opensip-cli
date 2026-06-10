import { parsePython, type PythonTree } from './parse.js';
import { stripComments, stripStrings } from './strip.js';

import type { LanguageAdapter } from '@opensip-tools/core';

export const pythonAdapter: LanguageAdapter<PythonTree> = {
  id: 'python',
  fileExtensions: ['.py', '.pyi'],
  aliases: ['py'],
  parse: parsePython,
  stripStrings,
  stripComments,
};

/** Plugin contract — exported as the lang plugin's `adapters` array. */
export const adapters = [pythonAdapter] as const;
