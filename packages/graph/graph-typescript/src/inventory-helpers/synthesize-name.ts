/**
 * Deterministic name synthesis for unnamed function-shaped nodes.
 *
 * Per spec §2.2: angle-bracketed names cannot collide with valid TS
 * identifiers, so the catalog can mix "real" simpleNames with
 * synthesized ones in the same map.
 */

export interface NameLocation {
  readonly filePath: string; // project-relative
  readonly line: number; // 1-based
  readonly column: number; // 0-based
}

export function synthesizeArrowName(loc: NameLocation): string {
  return `<arrow:${loc.filePath}:${String(loc.line)}:${String(loc.column)}>`;
}

export function synthesizeFunctionExpressionName(loc: NameLocation): string {
  return `<fn-expr:${loc.filePath}:${String(loc.line)}:${String(loc.column)}>`;
}

export function synthesizeModuleInitName(filePath: string): string {
  return `<module-init:${filePath}>`;
}
