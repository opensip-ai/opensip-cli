interface Res {
  status: (code: number) => Res
  json: (data: unknown) => Res
}

export function listItems(res: Res): Res {
  const data = { items: [1, 2, 3] }
  return res.status(200).json(data)
}
