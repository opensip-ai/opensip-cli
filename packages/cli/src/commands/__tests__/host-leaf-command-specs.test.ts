import { ToolRegistry } from '@opensip-cli/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  composeAndWriteReport: vi.fn(),
  executeAgentCatalog: vi.fn(),
  executeConfigure: vi.fn(),
  executeRuntimeStatus: vi.fn(),
  executeUninstall: vi.fn(),
  createInterface: vi.fn(),
  readlineQuestion: vi.fn(),
  readlineClose: vi.fn(),
}));

vi.mock('../../report-compose.js', () => ({
  composeAndWriteReport: mocks.composeAndWriteReport,
}));
vi.mock('../agent-catalog.js', () => ({ executeAgentCatalog: mocks.executeAgentCatalog }));
vi.mock('../configure.js', () => ({ executeConfigure: mocks.executeConfigure }));
vi.mock('../runtime-status.js', () => ({ executeRuntimeStatus: mocks.executeRuntimeStatus }));
vi.mock('../uninstall.js', () => ({ executeUninstall: mocks.executeUninstall }));
vi.mock('node:readline/promises', () => ({ createInterface: mocks.createInterface }));

import {
  createAgentCatalogCommandSpec,
  createConfigureCommandSpec,
  createReportCommandSpec,
  createStatusCommandSpec,
  createUninstallCommandSpec,
} from '../host-leaf-command-specs.js';

import type { CliCommandsContext } from '../shared.js';

const {
  composeAndWriteReport,
  executeAgentCatalog,
  executeConfigure,
  executeRuntimeStatus,
  executeUninstall,
  createInterface,
  readlineQuestion,
  readlineClose,
} = mocks;

interface UninstallPresentationInput {
  readonly project?: string | true;
  readonly write: (chunk: string) => void;
  readonly prompt: (question: string) => Promise<string>;
  readonly [key: string]: unknown;
}

function makeContext() {
  const tools = new ToolRegistry();
  const toolInternalCommands = new Set(['internal-probe']);
  const render = vi.fn<CliCommandsContext['render']>(() => Promise.resolve());
  const ctx = {
    setExitCode: vi.fn(),
    render,
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    emitError: vi.fn(),
    pluginLayouts: [],
    toolScaffolds: [],
    datastore: () => undefined,
    tools,
    toolInternalCommands,
  } satisfies CliCommandsContext;
  return { ctx, render, tools, toolInternalCommands };
}

beforeEach(() => {
  composeAndWriteReport.mockReset();
  executeAgentCatalog.mockReset();
  executeConfigure.mockReset();
  executeRuntimeStatus.mockReset();
  executeUninstall.mockReset();
  createInterface.mockReset();
  readlineQuestion.mockReset();
  readlineClose.mockReset();
  readlineQuestion.mockResolvedValue('yes');
  createInterface.mockReturnValue({
    question: readlineQuestion,
    close: readlineClose,
  });
});

describe('top-level host leaf command specs', () => {
  it('declares the expected host policies and option surfaces', () => {
    const { ctx } = makeContext();
    const configure = createConfigureCommandSpec();
    const status = createStatusCommandSpec();
    const report = createReportCommandSpec();
    const uninstall = createUninstallCommandSpec(ctx);
    const agentCatalog = createAgentCatalogCommandSpec(ctx);

    expect(configure).toMatchObject({
      name: 'configure',
      commonFlags: ['json', 'debug'],
      scope: 'none',
      hostRuntimePolicy: {
        runtimeAccess: 'user-state',
        bootstrapMode: 'standard',
      },
    });
    expect(status).toMatchObject({
      name: 'status',
      commonFlags: ['cwd', 'json', 'debug'],
      scope: 'none',
      noInit: true,
      hostRuntimePolicy: {
        runtimeAccess: 'default',
        bootstrapMode: 'inspection-only',
      },
    });
    expect(report.commonFlags).toEqual(['json', 'cwd']);
    expect(report.options?.map((option) => option.flag)).toEqual([
      '--no-open',
      '--run',
      '--max-catalog-mb',
    ]);
    expect(uninstall.options?.map((option) => option.flag)).toEqual([
      '-y, --yes',
      '--dry-run',
      '--user',
      '--project',
      '--purge',
      '--discard-recovery',
      '--json',
    ]);
    expect(agentCatalog).toMatchObject({
      name: 'agent-catalog',
      commonFlags: ['json'],
      scope: 'none',
    });
  });

  it('delegates configure and agent-catalog handlers through their exact inputs', async () => {
    const { ctx, tools, toolInternalCommands } = makeContext();
    const configureResult = { type: 'configure-result' };
    const catalogResult = { type: 'catalog-result' };
    executeConfigure.mockResolvedValue(configureResult);
    executeAgentCatalog.mockReturnValue(catalogResult);

    await expect(Promise.resolve(createConfigureCommandSpec().handler({}, ctx))).resolves.toBe(
      configureResult,
    );
    expect(executeConfigure).toHaveBeenCalledWith();

    expect(createAgentCatalogCommandSpec(ctx).handler({ json: true }, ctx)).toBe(catalogResult);
    expect(executeAgentCatalog).toHaveBeenLastCalledWith({
      json: true,
      tools,
      internalCommands: toolInternalCommands,
    });

    createAgentCatalogCommandSpec(ctx).handler({}, ctx);
    expect(executeAgentCatalog).toHaveBeenLastCalledWith({
      json: false,
      tools,
      internalCommands: toolInternalCommands,
    });
  });

  it('normalizes status defaults and preserves explicit project selection', () => {
    const { ctx } = makeContext();
    const result = { type: 'runtime-status-result' };
    const projectContext = { projectRoot: '/workspace' };
    executeRuntimeStatus.mockReturnValue(result);
    const spec = createStatusCommandSpec();

    expect(spec.handler({}, ctx)).toBe(result);
    expect(executeRuntimeStatus).toHaveBeenLastCalledWith({
      cwd: process.cwd(),
      cwdExplicit: false,
      projectContext: undefined,
    });

    expect(
      spec.handler(
        {
          cwd: '/workspace/subdir',
          cwdExplicit: true,
          config: '/workspace/opensip.custom.yml',
          projectContext,
        },
        ctx,
      ),
    ).toBe(result);
    expect(executeRuntimeStatus).toHaveBeenLastCalledWith({
      cwd: '/workspace/subdir',
      cwdExplicit: true,
      explicitConfigPath: '/workspace/opensip.custom.yml',
      projectContext,
    });
  });

  it('maps report selection, browser posture, and megabyte budget exactly', async () => {
    const { ctx } = makeContext();
    const result = { type: 'report-result' };
    composeAndWriteReport.mockResolvedValue(result);
    const spec = createReportCommandSpec();

    await expect(
      Promise.resolve(
        spec.handler(
          {
            open: true,
            json: false,
            run: 'RUN_01EXACT',
            maxCatalogMb: '1.5',
          },
          ctx,
        ),
      ),
    ).resolves.toBe(result);
    expect(composeAndWriteReport).toHaveBeenLastCalledWith({
      open: true,
      selection: { view: 'change-impact', runId: 'RUN_01EXACT' },
      maxGraphCatalogBytes: 1.5 * 1024 * 1024,
    });

    await Promise.resolve(spec.handler({ open: true, json: true }, ctx));
    expect(composeAndWriteReport).toHaveBeenLastCalledWith({ open: false });

    await Promise.resolve(spec.handler({ open: false, json: false }, ctx));
    expect(composeAndWriteReport).toHaveBeenLastCalledWith({ open: false });
  });

  it.each(['0', '-1', 'NaN', 'Infinity'])(
    'rejects invalid report catalog budget %s before delegation',
    (maxCatalogMb) => {
      const { ctx } = makeContext();
      const spec = createReportCommandSpec();

      expect(() => spec.handler({ open: false, json: false, maxCatalogMb }, ctx)).toThrow(
        /must be a positive number of megabytes/u,
      );
      expect(composeAndWriteReport).not.toHaveBeenCalled();
    },
  );

  it.each(['1e308', '0.0000001'])(
    'rejects report catalog budget %s when it cannot produce a finite positive byte count',
    (maxCatalogMb) => {
      const { ctx } = makeContext();
      const spec = createReportCommandSpec();

      expect(() => spec.handler({ open: false, json: false, maxCatalogMb }, ctx)).toThrow(
        /must be a positive number of megabytes/u,
      );
      expect(composeAndWriteReport).not.toHaveBeenCalled();
    },
  );

  it('rejects mutually exclusive uninstall targets before delegation', async () => {
    const { ctx } = makeContext();
    const spec = createUninstallCommandSpec(ctx);

    await expect(Promise.resolve(spec.handler({ user: true, project: true }, ctx))).rejects.toThrow(
      /mutually exclusive/u,
    );
    expect(executeUninstall).not.toHaveBeenCalled();
  });

  it('delegates project uninstall, serializes human output, and closes its prompt', async () => {
    const { ctx, render } = makeContext();
    const result = { type: 'uninstall-result' };
    let received: UninstallPresentationInput | undefined;
    executeUninstall.mockImplementation(async (input: UninstallPresentationInput) => {
      received = input;
      input.write('first\nsecond\n');
      input.write('tail');
      input.write('');
      expect(await input.prompt('Continue? ')).toBe('yes');
      return result;
    });
    const projectContext = { projectRoot: '/workspace' };
    const spec = createUninstallCommandSpec(ctx);

    await expect(
      Promise.resolve(
        spec.handler(
          {
            yes: false,
            dryRun: true,
            project: true,
            purge: true,
            discardRecovery: true,
            json: false,
            projectContext,
          },
          ctx,
        ),
      ),
    ).resolves.toBe(result);

    expect(executeUninstall).toHaveBeenCalledWith(
      expect.objectContaining({
        yes: false,
        dryRun: true,
        project: true,
        purge: true,
        discardRecovery: true,
        projectContext,
      }),
    );
    expect(render.mock.calls.map(([value]) => value)).toEqual([
      { type: 'text-lines', lines: ['first', 'second'] },
      { type: 'text-lines', lines: ['tail'] },
    ]);
    expect(createInterface).toHaveBeenCalledWith({
      input: process.stdin,
      output: process.stdout,
    });
    expect(readlineQuestion).toHaveBeenCalledWith('Continue? ');
    expect(readlineClose).toHaveBeenCalledOnce();
    expect(received?.write).toEqual(expect.any(Function));
  });

  it('normalizes a string project and suppresses presentation in JSON mode', async () => {
    const { ctx, render } = makeContext();
    executeUninstall.mockImplementation((input: UninstallPresentationInput) => {
      input.write('must not render\n');
      return Promise.resolve({ type: 'uninstall-json-result' });
    });
    const spec = createUninstallCommandSpec(ctx);

    await Promise.resolve(
      spec.handler(
        {
          project: '/workspace/project',
          json: true,
        },
        ctx,
      ),
    );

    expect(executeUninstall).toHaveBeenCalledWith(
      expect.objectContaining({
        project: '/workspace/project',
      }),
    );
    expect(render).not.toHaveBeenCalled();
    expect(createInterface).not.toHaveBeenCalled();
  });

  it('leaves the project target absent in default user uninstall mode', async () => {
    const { ctx } = makeContext();
    executeUninstall.mockResolvedValue({ type: 'uninstall-user-result' });
    const spec = createUninstallCommandSpec(ctx);

    await Promise.resolve(spec.handler({}, ctx));

    expect(executeUninstall).toHaveBeenCalledWith(
      expect.objectContaining({
        project: undefined,
      }),
    );
  });
});
