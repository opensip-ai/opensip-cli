import { describe, expect, it } from 'vitest';

import { DEFAULT_EXIT_MODEL, interpretExit } from '../exit-model.js';

import type { ScannerExitModel } from '../types.js';

const GITLEAKS: ScannerExitModel = { ok: [0], findings: [1], errorFrom: 2 };
const TRIVY: ScannerExitModel = { ok: [0], findings: [], errorFrom: 1 };

describe('interpretExit', () => {
  it('classifies ok / findings / fault for the default model', () => {
    expect(interpretExit(0, DEFAULT_EXIT_MODEL)).toBe('ok');
    expect(interpretExit(1, DEFAULT_EXIT_MODEL)).toBe('findings');
    expect(interpretExit(2, DEFAULT_EXIT_MODEL)).toBe('fault');
    expect(interpretExit(127, DEFAULT_EXIT_MODEL)).toBe('fault');
  });

  it('gitleaks disambiguation: exit 1 + invalid artifact ⇒ fault, valid ⇒ findings', () => {
    expect(interpretExit(1, GITLEAKS, { artifactValid: true })).toBe('findings');
    expect(interpretExit(1, GITLEAKS, { artifactValid: false })).toBe('fault');
    // undefined artifactValid is treated as valid (stdout scanners).
    expect(interpretExit(1, GITLEAKS)).toBe('findings');
  });

  it('trivy model: 0 is ok, any nonzero is a fault (no exit-code findings)', () => {
    expect(interpretExit(0, TRIVY)).toBe('ok');
    expect(interpretExit(1, TRIVY)).toBe('fault');
    expect(interpretExit(5, TRIVY)).toBe('fault');
  });

  it('prefers ok when a code appears in both ok and findings', () => {
    expect(interpretExit(0, { ok: [0], findings: [0] })).toBe('ok');
  });

  it('an unmodeled nonzero with no errorFrom is still a fault', () => {
    expect(interpretExit(3, { ok: [0], findings: [1] })).toBe('fault');
  });
});
