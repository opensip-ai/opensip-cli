// Clean: the contracts surface renders runs through the single RunPresentation
// variant. No per-tool *DoneResult interface, no `*-done` discriminator. The
// string 'fit-done' appearing here in prose is intentionally ignored by the
// AST-based check.

export interface RunPresentation {
  readonly type: 'run-presentation';
  readonly tool: string;
}

export interface GateDoneResult {
  readonly type: 'gate-done';
  readonly lines: readonly string[];
}

export type CommandResult = RunPresentation | GateDoneResult;
