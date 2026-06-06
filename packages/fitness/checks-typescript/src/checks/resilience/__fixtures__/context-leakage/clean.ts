import { AsyncLocalStorage } from 'node:async_hooks'

interface RequestContext {
  tenantId: string
}

const storage: AsyncLocalStorage<RequestContext> = new AsyncLocalStorage()

export function withContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn)
}

export function getTenant(): string | undefined {
  return storage.getStore()?.tenantId
}
