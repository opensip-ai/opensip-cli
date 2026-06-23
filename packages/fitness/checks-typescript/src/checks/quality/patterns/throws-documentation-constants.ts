/**
 * Self-documenting error allowlists for the throws-documentation check.
 */

import { getCheckConfig } from '@opensip-cli/fitness';

/**
 * Recipe-config shape for throws-documentation. Project-specific typed-error
 * suffixes belong in a recipe's `checks.config['throws-documentation']` block.
 */
export interface ThrowsDocConfig extends Record<string, unknown> {
  /** Class-name suffixes that mark a thrown error as self-documenting. */
  additionalSelfDocumentingSuffixes?: readonly string[];
}

/** Typed error classes that are self-documenting without @throws JSDoc. */
export const SELF_DOCUMENTING_ERRORS = new Set([
  'ValidationError',
  'AuthorizationError',
  'NotFoundError',
  'ConflictError',
  'DomainError',
  'SystemError',
  'ConfigurationError',
  'InfrastructureError',
  'ExternalServiceError',
  'DatabaseError',
  'CacheError',
  'NetworkError',
  'ApplicationError',
  'OperationError',
  'StateError',
  'IntegrationError',
  'BadRequestError',
  'UnauthorizedError',
  'ForbiddenError',
  'MethodNotAllowedError',
  'NotAcceptableError',
  'RequestTimeoutError',
  'GoneError',
  'PayloadTooLargeError',
  'UnsupportedMediaTypeError',
  'UnprocessableEntityError',
  'TooManyRequestsError',
  'InternalServerError',
  'NotImplementedError',
  'BadGatewayError',
  'ServiceUnavailableError',
  'GatewayTimeoutError',
  'InputValidationError',
  'BusinessRuleError',
  'AuthenticationError',
  'PermissionError',
  'ResourceNotFoundError',
  'DuplicateResourceError',
  'DataIntegrityError',
  'ToolError',
]);

export const SELF_DOCUMENTING_SUFFIXES = [
  'ValidationError',
  'NotFoundError',
  'AuthorizationError',
  'SystemError',
  'DomainError',
  'ConfigurationError',
  'SecurityError',
  'TimeoutError',
  'LockError',
  'LimitError',
  'InfrastructureError',
  'ApplicationError',
  'OperationError',
  'ErrorBuilder',
  'NetworkError',
  'ExecutionError',
  'LoadError',
  'VerifyError',
  'ApiError',
  'ParseError',
  'EncodingError',
  'DecodingError',
  'StateError',
  'SyncError',
  'CaptureError',
  'IntegrationError',
  'PermissionError',
  'AccessError',
  'AuthenticationError',
  'ResourceNotFoundError',
  'DuplicateResourceError',
  'DataIntegrityError',
  'BusinessRuleError',
  'InputValidationError',
];

export function buildEffectiveSuffixes(): readonly string[] {
  const cfg = getCheckConfig<ThrowsDocConfig>('throws-documentation');
  return [...SELF_DOCUMENTING_SUFFIXES, ...(cfg.additionalSelfDocumentingSuffixes ?? [])];
}

export function isSelfDocumentingError(errorType: string, suffixes: readonly string[]): boolean {
  if (SELF_DOCUMENTING_ERRORS.has(errorType)) {
    return true;
  }
  return suffixes.some((suffix) => errorType.endsWith(suffix));
}
