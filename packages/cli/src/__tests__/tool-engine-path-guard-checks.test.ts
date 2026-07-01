import { describe, expect, it } from 'vitest';

import { analyzeDirectStdoutInToolEngine } from '../../../../opensip-cli/fit/checks/no-direct-stdout-in-tool-engine.mjs';
import { analyzeNoRawFsArtifactWrite } from '../../../../opensip-cli/fit/checks/no-raw-fs-artifact-write-in-tool-engine.mjs';
import { analyzeAllSessionPersistRequiresReplay } from '../../../../opensip-cli/fit/checks/session-persist-requires-replay.mjs';
import {
  bundledToolPackageSegments,
  toolEnginePathRe,
} from '../../../../opensip-cli/fit/checks/tool-engine-paths.mjs';

describe('derived first-party tool-engine path gates', () => {
  it('derive the bundled tool segments from the manifest, including yagni', () => {
    expect(bundledToolPackageSegments).toEqual(
      expect.arrayContaining(['fitness', 'simulation', 'graph', 'yagni', 'mcp']),
    );
    expect(toolEnginePathRe().test('/repo/packages/yagni/engine/src/cli/run.ts')).toBe(true);
    expect(toolEnginePathRe().test('/repo/packages/mcp/src/command.ts')).toBe(true);
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

  it('requires sessionReplay when a first-party tool persists sessions', async () => {
    const files = new Map([
      [
        '/repo/packages/yagni/engine/src/tool.ts',
        'export const yagniTool = defineTool({ extensionPoints: { collectReportData } });',
      ],
      [
        '/repo/packages/yagni/engine/src/cli/execute-yagni.ts',
        'const payload = buildYagniSessionPayload(envelope, [], summary);',
      ],
      [
        '/repo/packages/graph/engine/src/tool.ts',
        'export const graphTool = defineTool({ extensionPoints: { sessionReplay: { replaySession } } });',
      ],
      [
        '/repo/packages/graph/engine/src/cli/session.ts',
        'const payload = buildGraphSessionPayload(signals);',
      ],
    ]);

    const findings = await analyzeAllSessionPersistRequiresReplay({
      paths: [...files.keys()],
      readMany: async (paths: readonly string[]) =>
        new Map(paths.map((path) => [path, files.get(path) ?? ''])),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        type: 'session-persist-requires-replay',
        filePath: '/repo/packages/yagni/engine/src/tool.ts',
      }),
    ]);
  });
});
