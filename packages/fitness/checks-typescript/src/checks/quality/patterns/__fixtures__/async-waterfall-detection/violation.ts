declare function fetchUser(): Promise<string>
declare function fetchOrders(): Promise<string[]>

export async function load(): Promise<void> {
  const user = await fetchUser()
  const orders = await fetchOrders()
  void user
  void orders
}
