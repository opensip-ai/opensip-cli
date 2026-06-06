export async function loadAll(ids: string[]): Promise<number[]> {
  return Promise.all(ids.map((id) => fetchOne(id)))
}

declare function fetchOne(id: string): Promise<number>
