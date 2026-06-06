import { z } from 'zod'

interface Req {
  body: unknown
}
interface Res {
  send: (data: unknown) => void
}

const bodySchema = z.object({ name: z.string() })

export function createUser(req: Req, res: Res): void {
  const parsed = bodySchema.parse(req.body)
  res.send(parsed)
}
