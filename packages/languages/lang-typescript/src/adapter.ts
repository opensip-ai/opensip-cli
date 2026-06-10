import { parseSource } from './parse.js';
import { typescriptQuery } from './query.js';
import { stripComments, stripStrings } from './strip.js';
import { discoverTypescriptWorkspaceUnits } from './workspace-units.js';

import type { LanguageAdapter } from '@opensip-tools/core/languages';
import type ts from 'typescript';

export const typescriptAdapter: LanguageAdapter<ts.SourceFile, ts.Node> = {
  id: 'typescript',
  fileExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  aliases: ['javascript', 'tsx', 'jsx', 'js'],
  parse: parseSource,
  stripStrings,
  stripComments,
  query: typescriptQuery,
  discoverWorkspaceUnits: discoverTypescriptWorkspaceUnits,
};

/** Plugin contract — exported as the lang plugin's `adapters` array. */
export const adapters = [typescriptAdapter] as const;
