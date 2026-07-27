export type GraphVisualizationDegradationCondition =
  'catalog-projection-failed' | 'renderer-asset-unavailable';

interface GraphVisualizationDegradation {
  readonly condition: GraphVisualizationDegradationCondition;
  readonly message: string;
}

/** Read one generator-recorded optional-visualization degradation for an in-page notice. */
export function graphVisualizationDegradation(
  condition: GraphVisualizationDegradationCondition,
): GraphVisualizationDegradation | undefined {
  const blob = document.querySelector('#graph-visualization-degradations');
  if (!blob?.textContent) return undefined;
  try {
    const decoded = JSON.parse(blob.textContent) as unknown;
    if (!Array.isArray(decoded)) return undefined;
    for (const entry of decoded as readonly unknown[]) {
      const record = entry as Record<string, unknown>;
      if (
        typeof entry === 'object' &&
        entry !== null &&
        record.condition === condition &&
        typeof record.message === 'string'
      ) {
        return { condition, message: record.message };
      }
    }
  } catch {
    // @swallow-ok malformed optional notice data falls back to the existing empty state.
  }
  return undefined;
}
