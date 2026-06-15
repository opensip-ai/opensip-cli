export function register(bus: Bus, repo: Repo): void {
  bus.subscribe('order.created', async (event: OrderEvent) => {
    await repo.save(event)
  })
}

interface Bus {
  subscribe(name: string, handler: (event: OrderEvent) => Promise<void>): void
}
interface Repo {
  save(event: OrderEvent): Promise<void>
}
interface OrderEvent {
  total: number
}
