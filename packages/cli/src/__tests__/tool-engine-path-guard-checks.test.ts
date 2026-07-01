import { describe, expect, it } from 'vitest';

import { analyzeMandatoryRunCommonFlags } from '../../../../opensip-cli/fit/checks/cross-tool-flag-parity.mjs';
import { analyzeDirectStdoutInToolEngine } from '../../../../opensip-cli/fit/checks/no-direct-stdout-in-tool-engine.mjs';
import { analyzeNoRawFsArtifactWrite } from '../../../../opensip-cli/fit/checks/no-raw-fs-artifact-write-in-tool-engine.mjs';
import { analyzeAllReportProducerOpenFlag } from '../../../../opensip-cli/fit/checks/report-producer-open-flag.mjs';
import { analyzeAllSessionPersistRequiresReplay } from '../../../../opensip-cli/fit/checks/session-persist-requires-replay.mjs';
import { analyzeSharedGateDispatch } from '../../../../opensip-cli/fit/checks/shared-gate-dispatch.mjs';
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
      readMany: (paths: readonly string[]) =>
        Promise.resolve(new Map(paths.map((path) => [path, files.get(path) ?? '']))),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        type: 'session-persist-requires-replay',
        filePath: '/repo/packages/yagni/engine/src/tool.ts',
      }),
    ]);
  });

  it('requires --open when a first-party tool contributes report data', async () => {
    const files = new Map([
      [
        '/repo/packages/graph/engine/src/tool.ts',
        'export const graphTool = defineTool({ extensionPoints: { collectReportData } });',
      ],
      [
        '/repo/packages/graph/engine/src/cli/graph/graph-command-spec.ts',
        "export const graphCommandSpec = definePrimaryCommand({ commonFlags: ['cwd', 'json'] });",
      ],
      [
        '/repo/packages/yagni/engine/src/tool.ts',
        'export const yagniTool = defineTool({ extensionPoints: { collectReportData: collectYagniReportData } });',
      ],
      [
        '/repo/packages/yagni/engine/src/cli/yagni-command-spec.ts',
        "export const spec = definePrimaryCommand({ commonFlags: ['cwd', 'json', 'open'] });",
      ],
    ]);

    const findings = await analyzeAllReportProducerOpenFlag({
      paths: [...files.keys()],
      readMany: (paths: readonly string[]) =>
        Promise.resolve(new Map(paths.map((path) => [path, files.get(path) ?? '']))),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        type: 'report-producer-open-flag',
        filePath: '/repo/packages/graph/engine/src/tool.ts',
      }),
    ]);
  });

  it('requires the shared reporting common flags for manual primary run commands', () => {
    const findings = analyzeMandatoryRunCommonFlags(`
      export const graphCommandSpec = definePrimaryCommand({
        commonFlags: ['cwd', 'json'],
        output: 'raw-stream',
        rawStreamReason: 'runtime-render-dispatch',
        producesVerdict: true,
      });
    `);

    expect(findings).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('quiet'),
      }),
    ]);
  });

  it('allows primary run commands through the shared preset or reporting flag constant', () => {
    expect(
      analyzeMandatoryRunCommonFlags(`
        export const graphCommandSpec = definePrimaryRunCommand({
          description: 'Build the graph',
          handler,
        });
      `),
    ).toEqual([]);
    expect(
      analyzeMandatoryRunCommonFlags(`
        export const graphCommandSpec = definePrimaryCommand({
          commonFlags: [...REPORTING_RUN_COMMON_FLAGS],
          output: 'raw-stream',
          rawStreamReason: 'runtime-render-dispatch',
          producesVerdict: true,
        });
      `),
    ).toEqual([]);
  });

  it('does not force non-primary runtime-dispatch commands into the primary run preset', () => {
    expect(
      analyzeMandatoryRunCommonFlags(`
        export const graphImpactCommandSpec = defineCommand({
          name: 'graph impact',
          commonFlags: ['cwd', 'json'],
          output: 'raw-stream',
          rawStreamReason: 'runtime-render-dispatch',
          handler,
        });
      `),
    ).toEqual([]);
  });

  it('requires the shared host gate-dispatch helper in production tool gate code', () => {
    const findings = analyzeSharedGateDispatch(
      `
        await cli.saveBaseline('graph', envelope);
        const result = await cli.compareBaseline('graph', envelope);
      `,
      '/repo/packages/graph/engine/src/cli/graph-modes.ts',
    );

    expect(findings).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('runHostGateDispatch'),
      }),
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('runHostGateDispatch'),
      }),
    ]);
  });

  it('allows the shared host gate-dispatch helper and skips test files', () => {
    expect(
      analyzeSharedGateDispatch(
        `
          await runHostGateDispatch({ cli, tool, envelope, mode: 'save' });
        `,
        '/repo/packages/external-tool-adapter/src/scan-emit.ts',
      ),
    ).toEqual([]);
    expect(
      analyzeSharedGateDispatch(
        "await cli.saveBaseline('graph', envelope);",
        '/repo/packages/graph/engine/src/cli/__tests__/graph-gate-mode.test.ts',
      ),
    ).toEqual([]);
  });
});
