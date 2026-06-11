import { parseRust, type RustTree } from './parse.js';
import { stripComments, stripStrings } from './strip.js';

import type { LanguageAdapter } from '@opensip-tools/core';

export const rustAdapter: LanguageAdapter<RustTree> = {
  id: 'rust',
  fileExtensions: ['.rs'],
  aliases: ['rs'],
  parse: parseRust,
  stripStrings,
  stripComments,
};

/** Plugin contract — exported as the lang plugin's `adapters` array. */
export const adapters = [rustAdapter] as const;
