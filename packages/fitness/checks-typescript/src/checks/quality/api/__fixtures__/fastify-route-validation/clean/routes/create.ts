import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

const bodySchema = z.object({ name: z.string() })

export function register(fastify: FastifyInstance): void {
  fastify.post('/users', (request, reply) => {
    const data = bodySchema.parse(request.body)
    reply.send(data)
  })
}
