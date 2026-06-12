/**
 * @fileoverview Behavioral tests for the shared `defineXxxScenario` validation
 * helpers. These guard the contract every kind's validator relies on: uniform
 * id/name/description shape checks, the target/workload BYO-seam checks, and the
 * collected-errors → ValidationError throw. Each test asserts a real validation
 * outcome (which field failed, with which message), not just that a line ran.
 */

import { ValidationError } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import {
  validateScenarioMetadata,
  validateTargetAndWorkload,
  throwValidationErrors,
  type ScenarioValidationError,
  type TargetWorkloadInput,
} from '../validation.js';

describe('validateScenarioMetadata', () => {
  it('accepts a fully-valid metadata block (no errors collected)', () => {
    const errors: ScenarioValidationError[] = [];
    validateScenarioMetadata(
      { id: 'my-scenario', name: 'My Scenario', description: 'does a thing' },
      errors,
    );
    expect(errors).toEqual([]);
  });

  it('flags a missing id', () => {
    const errors: ScenarioValidationError[] = [];
    validateScenarioMetadata({ name: 'n', description: 'd' }, errors);
    expect(errors).toContainEqual({ field: 'id', message: 'id is required' });
  });

  it('flags a whitespace-only id', () => {
    const errors: ScenarioValidationError[] = [];
    validateScenarioMetadata({ id: '   ', name: 'n', description: 'd' }, errors);
    expect(errors).toContainEqual({ field: 'id', message: 'id is required' });
  });

  it('flags an id whose shape is invalid (uppercase / spaces) by default', () => {
    const errors: ScenarioValidationError[] = [];
    validateScenarioMetadata({ id: 'Bad Id', name: 'n', description: 'd' }, errors);
    expect(errors).toContainEqual({
      field: 'id',
      message: 'id must be lowercase alphanumeric with hyphens',
    });
  });

  it("requireId: 'present-only' accepts a non-shaped but present id", () => {
    const errors: ScenarioValidationError[] = [];
    validateScenarioMetadata({ id: 'Has_Underscores', name: 'n', description: 'd' }, errors, {
      requireId: 'present-only',
    });
    expect(errors).toEqual([]);
  });

  it('flags a missing name when required and skips it when not', () => {
    const required: ScenarioValidationError[] = [];
    validateScenarioMetadata({ id: 'ok', description: 'd' }, required);
    expect(required).toContainEqual({ field: 'name', message: 'name is required' });

    const optional: ScenarioValidationError[] = [];
    validateScenarioMetadata({ id: 'ok', description: 'd' }, optional, { requireName: false });
    expect(optional).toEqual([]);
  });

  it('flags a missing description when required and skips it when not', () => {
    const required: ScenarioValidationError[] = [];
    validateScenarioMetadata({ id: 'ok', name: 'n' }, required);
    expect(required).toContainEqual({ field: 'description', message: 'description is required' });

    const optional: ScenarioValidationError[] = [];
    validateScenarioMetadata({ id: 'ok', name: 'n' }, optional, { requireDescription: false });
    expect(optional).toEqual([]);
  });
});

const validInput = (): TargetWorkloadInput => ({
  target: () => Promise.resolve({ ok: true } as never),
  workload: { rps: 10, concurrency: 2 },
});

describe('validateTargetAndWorkload', () => {
  it('accepts a valid target + workload block', () => {
    const errors: ScenarioValidationError[] = [];
    validateTargetAndWorkload(validInput(), errors);
    expect(errors).toEqual([]);
  });

  it('flags a non-function target (the BYO seam)', () => {
    const errors: ScenarioValidationError[] = [];
    validateTargetAndWorkload({ ...validInput(), target: 'not-a-fn' as never }, errors);
    expect(errors).toContainEqual({
      field: 'target',
      message: 'target must be a function (the BYO seam)',
    });
  });

  it('flags a non-positive rps', () => {
    const zero: ScenarioValidationError[] = [];
    validateTargetAndWorkload({ ...validInput(), workload: { rps: 0 } }, zero);
    expect(zero).toContainEqual({
      field: 'workload.rps',
      message: 'workload.rps must be a positive number',
    });

    const nonNumber: ScenarioValidationError[] = [];
    validateTargetAndWorkload({ ...validInput(), workload: { rps: 'x' } as never }, nonNumber);
    expect(nonNumber).toContainEqual({
      field: 'workload.rps',
      message: 'workload.rps must be a positive number',
    });
  });

  it('flags concurrency < 1 but accepts an omitted concurrency', () => {
    const tooLow: ScenarioValidationError[] = [];
    validateTargetAndWorkload({ ...validInput(), workload: { rps: 5, concurrency: 0 } }, tooLow);
    expect(tooLow).toContainEqual({
      field: 'workload.concurrency',
      message: 'workload.concurrency must be >= 1',
    });

    const omitted: ScenarioValidationError[] = [];
    validateTargetAndWorkload({ ...validInput(), workload: { rps: 5 } }, omitted);
    expect(omitted).toEqual([]);
  });
});

describe('throwValidationErrors', () => {
  it('is a no-op when no errors were collected', () => {
    expect(() => throwValidationErrors([], 'load')).not.toThrow();
  });

  it('throws a ValidationError with the canonical code and formats every collected error into the message', () => {
    const errors: ScenarioValidationError[] = [
      { field: 'id', message: 'id is required' },
      { field: 'name', message: 'name is required' },
    ];
    try {
      throwValidationErrors(errors, 'chaos');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const ve = error as ValidationError;
      expect(ve.code).toBe('VALIDATION.SCENARIO.INVALID_CONFIG');
      expect(ve.message).toContain('Invalid chaos scenario configuration');
      expect(ve.message).toContain('id: id is required');
      expect(ve.message).toContain('name: name is required');
    }
  });
});
