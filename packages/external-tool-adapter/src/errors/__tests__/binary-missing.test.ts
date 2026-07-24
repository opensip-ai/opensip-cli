import { normalizeFailure } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { spawnFailureError } from '../../process-exec.js';
import { externalToolErrorCatalog } from '../external-tool-error-catalog.js';

describe('scanner binary-missing (Plan 00 Phase 5.6)', () => {
  it('codes ENOENT as EXTERNAL.SCANNER.BINARY_MISSING with public action', () => {
    const error = spawnFailureError('gitleaks', 'ENOENT');
    expect(error.code).toBe('EXTERNAL.SCANNER.BINARY_MISSING');
    expect(error.definition).toBe(
      externalToolErrorCatalog.require('EXTERNAL.SCANNER.BINARY_MISSING'),
    );
    expect(error.metadata).toMatchObject({ command: 'gitleaks', errno: 'ENOENT' });
    expect(error.definition.operatorAction).toMatch(/PATH|binary/i);

    const envelope = normalizeFailure(error);
    expect(envelope.code).toBe('EXTERNAL.SCANNER.BINARY_MISSING');
    expect(envelope.definition.exitClass).toBe('configuration');
    expect(envelope.definition.kind).toBe('not-found');
  });

  it('codes other spawn errno as SPAWN_FAILED', () => {
    const error = spawnFailureError('trivy', 'EACCES');
    expect(error.code).toBe('EXTERNAL.SCANNER.SPAWN_FAILED');
    expect(error.definition.kind).toBe('I/O');
  });
});
