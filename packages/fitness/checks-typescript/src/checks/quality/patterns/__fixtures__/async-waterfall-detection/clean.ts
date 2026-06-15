declare function fetchUser(): Promise<string>
declare function fetchOrders(): Promise<string[]>

export async function load(): Promise<void> {
  const [user, orders] = await Promise.all([fetchUser(), fetchOrders()])
  void user
  void orders
}
