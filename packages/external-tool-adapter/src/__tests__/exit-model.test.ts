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

  describe('findingsFromNonzero (bitset / threshold scanners)', () => {
    // cargo-deny: exit is an OR of per-check category bits (advisories 1, bans 2,
    // licenses 4, sources 8). No single "findings" code; no error ceiling.
    const CARGO_DENY: ScannerExitModel = { ok: [0], findings: [], findingsFromNonzero: true };

    it('cargo-deny: any nonzero bitset with a valid artifact ⇒ findings', () => {
      expect(interpretExit(0, CARGO_DENY)).toBe('ok');
      for (const bitset of [1, 2, 4, 5, 8, 12, 15]) {
        expect(interpretExit(bitset, CARGO_DENY)).toBe('findings');
      }
    });

    it('cargo-deny: nonzero + invalid/garbage artifact ⇒ fault (not a false clean pass)', () => {
      expect(interpretExit(4, CARGO_DENY, { artifactValid: false })).toBe('fault');
    });

    // spotbugs: exit is a bugs(1)|missing-class(2)|error(4) mask. The error bit is
    // a genuine fault, so the ceiling sits at 4.
    const SPOTBUGS: ScannerExitModel = {
      ok: [0],
      findings: [],
      findingsFromNonzero: true,
      errorFrom: 4,
    };

    it('spotbugs: bugs/missing-class bits (1/2/3) ⇒ findings; error bit (>=4) ⇒ fault', () => {
      expect(interpretExit(1, SPOTBUGS)).toBe('findings');
      expect(interpretExit(2, SPOTBUGS)).toBe('findings');
      expect(interpretExit(3, SPOTBUGS)).toBe('findings');
      expect(interpretExit(4, SPOTBUGS)).toBe('fault');
      expect(interpretExit(6, SPOTBUGS)).toBe('fault');
    });

    // cargo-clippy: 0 (clean, even with warnings) or 101 (deny-level lints /
    // compile error). 101 with parseable diagnostics is a findings verdict.
    const CARGO_CLIPPY: ScannerExitModel = { ok: [0], findings: [], findingsFromNonzero: true };

    it('cargo-clippy: exit 101 with a valid artifact ⇒ findings', () => {
      expect(interpretExit(0, CARGO_CLIPPY)).toBe('ok');
      expect(interpretExit(101, CARGO_CLIPPY)).toBe('findings');
      expect(interpretExit(101, CARGO_CLIPPY, { artifactValid: false })).toBe('fault');
    });

    it('the ceiling wins over the reclaim even when findingsFromNonzero is set', () => {
      const model: ScannerExitModel = {
        ok: [0],
        findings: [],
        findingsFromNonzero: true,
        errorFrom: 2,
      };
      expect(interpretExit(1, model)).toBe('findings');
      expect(interpretExit(2, model)).toBe('fault');
      expect(interpretExit(9, model)).toBe('fault');
    });
  });
});
