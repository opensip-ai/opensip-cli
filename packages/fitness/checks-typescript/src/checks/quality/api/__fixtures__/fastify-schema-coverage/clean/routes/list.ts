import type { FastifyInstance } from 'fastify'

export function register(fastify: FastifyInstance): void {
  fastify.get(
    '/users',
    {
      schema: {
        response: {
          200: { type: 'array' },
        },
      },
    },
    (_request, reply) => {
      reply.send([])
    },
  )
}
