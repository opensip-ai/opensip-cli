/**
 * Walk the alias chain to the original ts.Symbol.
 *
 * `import { foo } from './x'` produces an alias symbol whose
 * declarations are the import specifier itself; getAliasedSymbol
 * follows the chain to the actual declaration.
 */

import ts from 'typescript';

export function unaliasSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  let current = symbol;
  // Cap iterations defensively; realistic chains are 1–2 hops.
  for (let i = 0; i < 8; i++) {
    if ((current.flags & ts.SymbolFlags.Alias) === 0) return current;
    try {
      const next = checker.getAliasedSymbol(current);
      if (next === current) return current;
      current = next;
    } catch {
      return current;
    }
  }
  return current;
}
