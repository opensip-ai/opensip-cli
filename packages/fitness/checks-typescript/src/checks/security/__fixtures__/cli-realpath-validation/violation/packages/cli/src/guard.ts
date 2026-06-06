import { resolve } from 'node:path'

export function isInside(child: string, projectRoot: string): boolean {
  const resolved = resolve(child)
  return resolved.startsWith(projectRoot)
}
