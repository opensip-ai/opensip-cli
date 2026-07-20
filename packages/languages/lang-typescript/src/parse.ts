import ts from 'typescript';

/**
 * .ts/.mts/.cts files parse as plain TS; every other extension this adapter
 * handles (.tsx/.js/.jsx/.mjs/.cjs) parses as TSX, permissively. TSX mode
 * disambiguates a bare `<T>` as a JSX opening tag, which misparses valid
 * plain-TS syntax (generic arrow functions, `<T>value` casts) and swallows
 * the remainder of the file into inert JSX nodes — so plain TS files must
 * not use TSX mode.
 */
function scriptKindFor(filePath: string): ts.ScriptKind {
  return /\.[mc]?ts$/.test(filePath) ? ts.ScriptKind.TS : ts.ScriptKind.TSX;
}

/**
 * Parse TypeScript/JavaScript source into a SourceFile.
 * Returns null on parse failure.
 */
export function parseSource(content: string, filePath: string): ts.SourceFile | null {
  try {
    return ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      scriptKindFor(filePath),
    );
  } catch {
    return null;
  }
}
