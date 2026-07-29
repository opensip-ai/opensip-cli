import { ValidationError } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { checkFileTooLargeError } from '../check-file-too-large-error.js';

describe('checkFileTooLargeError', () => {
  it('names the check and input while preserving the branch discriminator', () => {
    const error = checkFileTooLargeError({
      check: 'docker-ignore-validation',
      condition: 'dockerignore-input',
      filePath: '/project/.dockerignore',
      actualBytes: 10_000_001,
      maxBytes: 10_000_000,
    });

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe('FIT.FITNESS.FILE_TOO_LARGE');
    expect(error.message).toContain("Check 'docker-ignore-validation'");
    expect(error.message).toContain("'/project/.dockerignore'");
    expect(error.metadata).toEqual({
      actualBytes: 10_000_001,
      condition: 'dockerignore-input',
      maxBytes: 10_000_000,
    });
  });
});
