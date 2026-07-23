import { logger } from './logger.js'

export function loadConfigJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (err) {
    logger.warn({ evt: 'parse.failed', err })
    return null
  }
}

type Result<T> = { ok: true; value: T } | { ok: false; error: Error }

// Native Result error handled by logging (clean).
export function firstLineLogged(read: () => Result<string>): string | undefined {
  const result = read()
  if (!result.ok) {
    logger.warn({ evt: 'read.failed', err: result.error })
    return undefined
  }
  return result.value.split('\n')[0]
}

// Native Result error with an explicit intentional-degradation marker (clean).
export function firstLineOrSkip(read: () => Result<string>): string | undefined {
  const result = read()
  if (!result.ok) {
    // @swallow-ok: best-effort read; an unreadable source degrades to "skip".
    return undefined
  }
  return result.value.split('\n')[0]
}
