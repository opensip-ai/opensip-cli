interface RequestContext {
  tenantId: string
}

let activeContext: RequestContext | null = null

export function setContext(ctx: RequestContext): void {
  activeContext = ctx
}

export function getTenant(): string | undefined {
  return activeContext?.tenantId
}
