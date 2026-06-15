export async function load(repo: Repo): Promise<Row[]> {
  return repo.findAll({ take: 100 })
}

interface Repo {
  findAll(opts: { take: number }): Promise<Row[]>
}
interface Row {
  id: string
}
