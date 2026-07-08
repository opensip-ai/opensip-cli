// Violation: re-introducing a per-tool run done-result on the contracts surface.
// The named interface (FitDoneResult) and the `type: 'graph-done'` discriminator
// are both flagged — runs must render through the single RunPresentation variant.

export interface FitDoneResult {
  readonly type: 'fit-done';
  readonly label: string;
  readonly envelope: unknown;
}

export interface GraphRunResult {
  readonly type: 'graph-done';
  readonly summary: { readonly passed: number };
}

export type CommandResult = FitDoneResult | GraphRunResult;
