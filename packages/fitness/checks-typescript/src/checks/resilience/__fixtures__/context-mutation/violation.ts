interface Context {
  tenant: string
}

export function enrich(ctx: Context, value: string): void {
  ctx.tenant = value
}
