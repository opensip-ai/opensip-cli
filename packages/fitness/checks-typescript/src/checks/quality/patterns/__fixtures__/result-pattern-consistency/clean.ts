class ValidationError extends Error {}

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }

function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function applyName(name: string): Result<string, ValidationError> {
  if (name.length === 0) {
    return err(new ValidationError('name is required'))
  }
  return ok(name)
}
