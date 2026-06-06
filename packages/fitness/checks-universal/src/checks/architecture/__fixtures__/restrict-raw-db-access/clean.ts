import { userRepo } from './persistence/user-repo.js'

export async function getUser(id: string): Promise<unknown> {
  return userRepo.findById(id)
}
