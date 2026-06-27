import { describe, expect, it } from 'vitest';

import { analyzeDirectStdoutInToolEngine } from '../../../../opensip-cli/fit/checks/no-direct-stdout-in-tool-engine.mjs';
import { analyzeNoRawFsArtifactWrite } from '../../../../opensip-cli/fit/checks/no-raw-fs-artifact-write-in-tool-engine.mjs';
import {
  bundledToolPackageSegments,
  toolEnginePathRe,
} from '../../../../opensip-cli/fit/checks/tool-engine-paths.mjs';

describe('derived first-party tool-engine path gates', () => {
  it('derive the bundled tool segments from the manifest, including yagni', () => {
    expect(bundledToolPackageSegments).toEqual(
      expect.arrayContaining(['fitness', 'simulation', 'graph', 'yagni']),
    );
    expect(toolEnginePathRe().test('/repo/packages/yagni/engine/src/cli/run.ts')).toBe(true);
  });

  it('flags direct stdout in a yagni tool-engine path', () => {
    const findings = analyzeDirectStdoutInToolEngine(
      'process.stdout.write("raw run output");',
      '/repo/packages/yagni/engine/src/cli/run.ts',
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('error');
  });

  it('flags raw fs artifact writes in first-party tool-engine paths', () => {
    const findings = analyzeNoRawFsArtifactWrite(
      'writeFileSync(outPath, bytes);',
      '/repo/packages/yagni/engine/src/cli/catalog.ts',
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.type).toBe('no-raw-fs-artifact-write-in-tool-engine');
  });

  it('allows cli.writeArtifact and explicitly allowlisted ephemeral files', () => {
    expect(
      analyzeNoRawFsArtifactWrite(
        'await cli.writeArtifact(outPath, bytes);',
        '/repo/packages/yagni/engine/src/cli/catalog.ts',
      ),
    ).toEqual([]);
    expect(
      analyzeNoRawFsArtifactWrite(
        'writeFileSync(profilePath, bytes);',
        '/repo/packages/graph/engine/src/cli/profile.ts',
      ),
    ).toEqual([]);
  });
});
