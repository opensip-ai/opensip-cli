import ts from 'typescript'

/**
 * Parse TypeScript/JavaScript source into a SourceFile.
 * Returns null on parse failure.
 *
 * Uses ts.ScriptKind.TSX so the same parse path handles .ts and .tsx
 * (and is permissive enough for .js / .jsx).
 */
export function parseSource(content: string, filePath: string): ts.SourceFile | null {
  try {
    return ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      ts.ScriptKind.TSX,
    )
  } catch {
    // @fitness-ignore-next-line error-handling-quality -- defensive parse-or-null helper; ts.createSourceFile is permissive (recovers from syntax errors) and effectively does not throw on real input, so caller's null-check is belt-and-suspenders.
    return null
  }
}
