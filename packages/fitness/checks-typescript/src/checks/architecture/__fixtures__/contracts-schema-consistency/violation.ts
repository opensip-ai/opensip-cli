import { z } from 'zod'

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
})

export type User = {
  id: string
  name: string
}
