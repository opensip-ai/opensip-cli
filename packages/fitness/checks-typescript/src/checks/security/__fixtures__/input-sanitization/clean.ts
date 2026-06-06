import { execFile } from 'node:child_process'

const ALLOWED = new Set(['status', 'version'])

export function runForUser(req: { body: { cmd: string } }): void {
  const command = ALLOWED.has(req.body.cmd) ? req.body.cmd : 'status'
  execFile('git', [command])
}
