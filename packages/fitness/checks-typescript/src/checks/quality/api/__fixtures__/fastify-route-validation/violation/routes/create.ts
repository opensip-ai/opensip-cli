import type { FastifyInstance } from 'fastify'

export function register(fastify: FastifyInstance): void {
  fastify.post('/users', (request, reply) => {
    const data = request.body
    reply.send(data)
  })
}
