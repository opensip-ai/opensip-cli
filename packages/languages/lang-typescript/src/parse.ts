import ts from 'typescript';

/**
 * Resolve the TypeScript parser mode from a source filename.
 *
 * Unknown extensions retain the adapter's historically permissive TSX mode,
 * while known TypeScript/JavaScript extensions use their exact grammar.
 */
export function scriptKindForFilePath(filePath: string): ts.ScriptKind {
  const normalized = filePath.toLowerCase();
  if (normalized.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (normalized.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (normalized.endsWith('.ts') || normalized.endsWith('.mts') || normalized.endsWith('.cts')) {
    return ts.ScriptKind.TS;
  }
  if (normalized.endsWith('.js') || normalized.endsWith('.mjs') || normalized.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  if (normalized.endsWith('.json')) return ts.ScriptKind.JSON;
  return ts.ScriptKind.TSX;
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
      scriptKindForFilePath(filePath),
    );
  } catch {
    return null;
  }
}
