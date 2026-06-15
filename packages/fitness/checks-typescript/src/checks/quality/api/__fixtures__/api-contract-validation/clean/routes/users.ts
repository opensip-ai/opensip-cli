import { z } from 'zod'

interface Req {
  body: unknown
}
interface Res {
  send: (data: unknown) => void
}

const bodySchema = z.object({ name: z.string() })

export function usersHandler(req: Req, res: Res): void {
  try {
    const parsed = bodySchema.parse(req.body)
    res.send(parsed)
  } catch {
    res.send({ error: 'invalid' })
  }
}
