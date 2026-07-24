
import { EXIT_CODES, mapExitClassToExitCode } from '@opensip-cli/contracts';
import { normalizeFailure } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { ScenarioAbortedError } from '../scenario-aborted-error.js';

describe('ScenarioAbortedError', () => {
  it('retains scenarioId metadata and cancelled definition', () => {
    const error = new ScenarioAbortedError('sc-1');
    expect(error.scenarioId).toBe('sc-1');
    expect(error.metadata).toEqual({ scenarioId: 'sc-1' });
    expect(error.definition.kind).toBe('cancelled');
    expect(error.definition.exitClass).toBe('cancelled');

    const envelope = normalizeFailure(error);
    expect(envelope.definition.kind).toBe('cancelled');
    expect(envelope.message).toContain('sc-1');
    expect(mapExitClassToExitCode(envelope.definition.exitClass)).toBe(EXIT_CODES.CANCELLED);
  });
});
