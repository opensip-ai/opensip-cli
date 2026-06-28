import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveScannerArtifactPath } from '../artifact-path.js';

describe('resolveScannerArtifactPath', () => {
  const scope = {
    artifactDir: (tool: string) => join('/proj/opensip-cli/.runtime/artifacts', tool),
    runId: 'run-123',
  };

  it('composes <artifactDir(tool)>/<runId>/<name> (run segment substrate-side)', () => {
    expect(resolveScannerArtifactPath(scope, 'gitleaks', 'gitleaks.json')).toBe(
      join('/proj/opensip-cli/.runtime/artifacts', 'gitleaks', 'run-123', 'gitleaks.json'),
    );
  });

  it('keeps each run under its own immediate child of artifactDir(tool) (the prune boundary)', () => {
    const a = resolveScannerArtifactPath({ ...scope, runId: 'r1' }, 'trivy', 'trivy.sarif');
    const b = resolveScannerArtifactPath({ ...scope, runId: 'r2' }, 'trivy', 'trivy.sarif');
    expect(a).toContain(join('trivy', 'r1'));
    expect(b).toContain(join('trivy', 'r2'));
  });
});
