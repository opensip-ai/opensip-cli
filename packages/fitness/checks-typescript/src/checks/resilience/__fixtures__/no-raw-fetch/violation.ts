export async function load(url: string): Promise<unknown> {
  const response = await fetch(url)
  return response.json()
}
