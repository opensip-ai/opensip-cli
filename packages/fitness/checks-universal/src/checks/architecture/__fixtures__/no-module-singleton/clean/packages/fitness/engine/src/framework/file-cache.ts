// Clean: the ADR-0023-exempt run-scoped fileCache singleton — allowlisted by file+id.
export const fileCache = new FileCache()
declare class FileCache {}
