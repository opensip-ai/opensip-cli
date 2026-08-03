/**
 * Regression: a target that escapes the project/cache roots must be refused
 * as an internal invariant failure (`CLI.UNINSTALL.TARGET_ESCAPES_ROOTS`,
 * authored `kind: 'integrity'` / `defaultResponsibility: 'tool-author'`), not
 * as an ordinary user-input mistake. The exit code is how downstream
 * automation (CI, the platform, telemetry) tells "the deletion plan itself
 * was computed wrong — escalate" apart from "the user passed a bad path —
 * ask them to fix it and retry".
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mapFailureToExitCode } from '@opensip-cli/contracts';
import { SystemError, ValidationError } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { performProjectDeletion } from '../project-removal-safety.js';

import type { Target } from '../targets.js';

describe('performProjectDeletion — containment invariant', () => {
  let projectDir: string;
  let outsideDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'uninstall-project-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'uninstall-outside-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('refuses a target outside the project/cache roots as a SystemError (exit 1, not 2) — regression', () => {
    // A real directory that exists but resolves outside both the project dir
    // and the user cache root — the containment check must refuse it.
    const escapee: Target = {
      path: outsideDir,
      kind: 'dir',
      sizeBytes: 0,
      bucket: 'runtime',
    };

    let caught: unknown;
    try {
      performProjectDeletion([escapee], false, projectDir);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SystemError);
    expect(caught).not.toBeInstanceOf(ValidationError);
    expect((caught as { code?: string }).code).toBe('CLI.UNINSTALL.TARGET_ESCAPES_ROOTS');
    // This is the load-bearing assertion: a genuine internal-invariant breach
    // must map to the internal/runtime exit code, not the ordinary
    // configuration-error exit code used for user typos.
    expect(mapFailureToExitCode(caught)).toBe(1);
  });
});
