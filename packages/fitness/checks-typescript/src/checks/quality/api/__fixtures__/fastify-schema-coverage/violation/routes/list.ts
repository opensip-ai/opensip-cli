import type { FastifyInstance } from 'fastify'

export function register(fastify: FastifyInstance): void {
  fastify.get('/users', (_request, reply) => {
    reply.send([])
  })
}
