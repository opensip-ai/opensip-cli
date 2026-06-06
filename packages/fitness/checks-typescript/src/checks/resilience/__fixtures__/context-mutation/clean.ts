interface Context {
  tenant: string
}

export function enrich(ctx: Context, value: string): Context {
  return { ...ctx, tenant: value }
}
