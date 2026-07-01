/**
 * Shared "Validated" table-cell formatting for live-run and static tables.
 *
 * Pure helpers with no opensip-cli deps — used by {@link liveRunTable} and
 * fitness envelope derivations so the column cannot drift per tool.
 */

/** Render a validated-count cell with singular/plural noun (e.g. `450 files`, `1 file`, `—`). */
export function formatValidatedCell(totalItems: number | undefined, itemType = 'items'): string {
  if (!totalItems) return '—';
  const singular = itemType.endsWith('s') ? itemType.slice(0, -1) : itemType;
  return totalItems === 1 ? `${totalItems} ${singular}` : `${totalItems} ${itemType}`;
}

/** Parse the leading integer out of a validated cell — e.g. `"171 files"` → `171`, `"—"` → `0`. */
export function parseValidatedCellCount(validated: string): number {
  if (validated === '—') return 0;
  const match = /^(\d+)/.exec(validated);
  return match ? Number.parseInt(match[1], 10) : 0;
}
