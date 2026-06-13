// Clean: a tool engine that routes all output and state through the documented
// ToolCliContext seams — no direct stdout, no pre-scope holder, no datastore
// construction.
interface Ctx {
  readonly emitJson: (value: unknown) => void;
  readonly scope: { datastore: () => unknown };
}

export function run(ctx: Ctx): void {
  const store = ctx.scope.datastore();
  ctx.emitJson({ ok: true, hasStore: store !== undefined });
}
