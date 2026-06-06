import { realpathSync } from 'node:fs'
import { relative } from 'node:path'

export function isInside(child: string, projectRoot: string): boolean {
  const rel = relative(realpathSync(projectRoot), realpathSync(child))
  return rel !== '' && !rel.startsWith('..')
}
