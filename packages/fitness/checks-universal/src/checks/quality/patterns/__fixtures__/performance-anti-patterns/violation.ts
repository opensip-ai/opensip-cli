export async function loadAll(ids: string[]): Promise<number[]> {
  const out: number[] = []
  for (let i = 0; i < ids.length; i++) { const value = await fetchOne(ids[i]); out.push(value) }
  return out
}

declare function fetchOne(id: string): Promise<number>
