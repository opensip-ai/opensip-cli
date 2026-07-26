/**
 * `ErrorDefinitionError` — the one failure the error-definition machinery itself can raise.
 *
 * WHY THIS IS A SEPARATE LEAF MODULE (Plan 01 ruling D10)
 * This type is thrown *by* catalog validation, so it cannot import a catalog to carry a
 * registered `ErrorDefinition` — `error-definition.ts` would then depend on a catalog that
 * depends on `error-definition.ts`. Extracting it to a module that imports nothing breaks
 * that cycle and lets `errors.ts` re-export the resolved definition without either file
 * importing the other.
 *
 * WHY `code` IS DELIBERATELY NOT DECLARED HERE
 * The former shape declared `readonly code = 'CORE.ERROR_DEFINITION.INVALID'` on a bare
 * `Error` subclass. `normalizeFailure` routes anything that is not a `ToolError` through
 * `fromNativeError`, which reads `.code` as a **node errno** — so the catalog's own
 * validation failure was published as `metadata.errno = 'CORE.ERROR_DEFINITION.INVALID'`
 * with definition `SYSTEM_ERROR` and `known: 'unknown'`. The code now lives in the catalog
 * (`CORE.ERROR_DEFINITION.INVALID`) and reaches the envelope through the structural brand
 * below rather than through a field the native boundary will misread.
 */

/**
 * Brand marking a throwable as the error-definition machinery's own validation failure.
 *
 * A `Symbol.for` key rather than `instanceof`: pnpm's `injectWorkspacePackages` can place
 * two physical copies of `@opensip-cli/core` in one process, and `instanceof` is false
 * across them. The registry-collision path throws from whichever copy validated the
 * catalog and is caught by whichever copy the host loaded, so a structural test is the
 * only one that holds. This mirrors `isToolErrorLike`'s cross-copy strategy in `errors.ts`.
 */
export const ERROR_DEFINITION_ERROR_BRAND = Symbol.for('@opensip-cli/core/errorDefinitionError');

/** Thrown when an error definition or catalog fails validation. */
export class ErrorDefinitionError extends Error {
  /** Structural brand — survives a duplicate-core boundary where `instanceof` does not. */
  readonly [ERROR_DEFINITION_ERROR_BRAND] = true;

  constructor(message: string) {
    super(message);
    this.name = 'ErrorDefinitionError';
  }
}

/**
 * Structural test for {@link ErrorDefinitionError}, valid across duplicate core copies.
 *
 * Reads the branded property behind a `try` because the value may be a hostile plugin
 * object with a throwing getter: admission code calls this while deciding whether a
 * contribution is safe, so the test itself must not be a way to run plugin code.
 */
export function isErrorDefinitionErrorLike(value: unknown): value is ErrorDefinitionError {
  if (typeof value !== 'object' || value === null) return false;
  try {
    return (value as Record<symbol, unknown>)[ERROR_DEFINITION_ERROR_BRAND] === true;
  } catch {
    // @swallow-ok this IS the predicate: a value whose property access throws is, definitively,
    // not one of ours. `false` is the answer, not a swallowed failure — and logging here would
    // let a hostile object emit output merely by being type-tested.
    return false;
  }
}
