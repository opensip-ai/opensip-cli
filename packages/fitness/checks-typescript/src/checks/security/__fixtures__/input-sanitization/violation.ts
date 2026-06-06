import { execSync } from 'node:child_process'

export function runForUser(req: { body: { cmd: string } }): void {
  execSync(req.body.cmd)
}
