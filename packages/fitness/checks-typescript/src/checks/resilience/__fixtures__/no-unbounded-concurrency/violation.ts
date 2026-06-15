export async function processAll(items: string[]): Promise<string[]> {
  return Promise.all(items.map((item) => Promise.resolve(item)))
}
