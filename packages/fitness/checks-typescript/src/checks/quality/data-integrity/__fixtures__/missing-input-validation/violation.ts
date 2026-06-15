interface Req {
  body: unknown
}
interface Res {
  send: (data: unknown) => void
}

export function createUser(req: Req, res: Res): void {
  res.send(req.body)
}
