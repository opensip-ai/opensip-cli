import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunScope, runWithScopeSync } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { authoritativeEvidenceCwd } from '../evidence-cwd.js';

let container: string;
let project: string;
let nested: string;
let alias: string;
let outside: string;

beforeEach(() => {
  container = realpathSync(mkdtempSync(join(tmpdir(), 'opensip-evidence-cwd-')));
  project = join(container, 'project');
  nested = join(project, 'packages', 'app');
  outside = join(container, 'outside');
  alias = join(container, 'project-alias');
  mkdirSync(nested, { recursive: true });
  mkdirSync(outside);
  symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
});

afterEach(() => {
  rmSync(container, { recursive: true, force: true });
});

function projectScope(): RunScope {
  return new RunScope({
    projectContext: {
      cwd: join(alias, 'packages', 'app'),
      cwdExplicit: true,
      projectRoot: realpathSync(project),
      configPath: join(realpathSync(project), 'opensip-cli.config.yml'),
      walkedUp: 2,
      scope: 'project',
    },
  });
}

describe('authoritativeEvidenceCwd', () => {
  it('canonicalizes a contributed alias while preserving its nested directory', () => {
    const result = runWithScopeSync(projectScope(), () =>
      authoritativeEvidenceCwd(join(alias, 'packages', 'app')),
    );

    expect(result).toBe(realpathSync(nested));
  });

  it('rejects an outside contribution in favor of the canonical host invocation cwd', () => {
    const result = runWithScopeSync(projectScope(), () => authoritativeEvidenceCwd(outside));

    expect(result).toBe(realpathSync(nested));
  });

  it('canonicalizes an existing directory outside project scope', () => {
    expect(authoritativeEvidenceCwd(join(alias, 'packages', 'app'))).toBe(realpathSync(nested));
  });

  it('preserves a missing historical path when no project authority exists', () => {
    const missing = join(container, 'missing');
    expect(authoritativeEvidenceCwd(missing)).toBe(missing);
  });
});
