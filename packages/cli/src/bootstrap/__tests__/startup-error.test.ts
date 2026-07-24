import { EXIT_CODES } from '@opensip-cli/contracts';
import { ConfigurationError, SystemError, TimeoutError } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { startupFailureAsBootstrapError } from '../startup-error.js';

describe('startup failure presentation', () => {
  it.each([
    [
      'configuration',
      new ConfigurationError('recovery required', {
        code: 'CONFIGURATION.RECOVERY_REQUIRED',
      }),
      EXIT_CODES.CONFIGURATION_ERROR,
    ],
    [
      'timeout',
      new TimeoutError('runtime lease timed out', {
        code: 'TIMEOUT.RUNTIME_ACCESS_COMPOSITE',
      }),
      EXIT_CODES.RUNTIME_ERROR,
    ],
    [
      'system',
      new SystemError('unsafe coordination root', {
        code: 'SYSTEM.RUNTIME_COORDINATION.UNSAFE_ROOT',
      }),
      EXIT_CODES.RUNTIME_ERROR,
    ],
  ] as const)('preserves the canonical %s exit code', (label, error, exitCode) => {
    const wrapped = startupFailureAsBootstrapError(error);

    expect(wrapped.exitCode).toBe(exitCode);
    expect(wrapped.message).toBe(label === 'system' ? 'The operation failed.' : error.message);
  });
});
