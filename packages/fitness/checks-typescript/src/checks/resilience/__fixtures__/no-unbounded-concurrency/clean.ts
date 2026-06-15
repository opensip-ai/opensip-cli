import pLimit from 'p-limit'

export async function processAll(items: string[]): Promise<string[]> {
  const limit = pLimit(10)
  return Promise.all(items.map((item) => limit(() => Promise.resolve(item))))
}
