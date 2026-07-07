import { execFile } from 'node:child_process'

const ALLOWED = new Set(['status', 'version'])

export function runForUser(req: { body: { cmd: string } }): void {
  const command = ALLOWED.has(req.body.cmd) ? req.body.cmd : 'status'
  execFile('git', [command])
}

const EMAIL_RE = /^[^@]+@[^@]+$/

// `.exec` here is RegExp.prototype.exec, NOT child_process.exec — it must not be
// flagged as command injection. Regression guard: the exec rule now requires a
// child_process callee, so a regex's `.exec(req.body.x)` no longer false-fires.
export function validateEmail(req: { body: { email: string } }): boolean {
  return EMAIL_RE.exec(req.body.email) !== null
}
