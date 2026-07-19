import { RunScope, runWithScopeSync } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { workerProjectSelectionArgs } from '../worker-project-selection.js';

describe('workerProjectSelectionArgs', () => {
  it('forwards the active project config without splitting paths containing spaces', () => {
    const scope = new RunScope({
      projectContext: {
        cwd: '/repo/subdir',
        cwdExplicit: false,
        projectRoot: '/repo',
        configPath: '/repo/custom config.yml',
        walkedUp: 1,
        scope: 'project',
      },
    });

    expect(runWithScopeSync(scope, () => workerProjectSelectionArgs('/repo/subdir'))).toEqual([
      '--cwd',
      '/repo/subdir',
      '--config',
      '/repo/custom config.yml',
    ]);
  });

  it('uses only cwd when no scoped config is active', () => {
    expect(runWithScopeSync(new RunScope(), () => workerProjectSelectionArgs('/repo'))).toEqual([
      '--cwd',
      '/repo',
    ]);
  });
});
