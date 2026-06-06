export async function load(repo: Repo): Promise<Row[]> {
  return repo.findAll()
}

interface Repo {
  findAll(): Promise<Row[]>
}
interface Row {
  id: string
}
