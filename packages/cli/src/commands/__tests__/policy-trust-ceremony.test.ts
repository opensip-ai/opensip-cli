import { EXIT_CODES } from '@opensip-cli/contracts';
import { RunScope, runWithScopeSync } from '@opensip-cli/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PolicyAuditCollector } from '../../bootstrap/policy-audit.js';
import { executePolicyTrust, executePolicyUntrust } from '../policy-trust-ceremony.js';

import type { CliCommandsContext } from '../shared.js';
import type * as ConfigModule from '@opensip-cli/config';
import type * as CoreModule from '@opensip-cli/core';
import type { ProjectContext } from '@opensip-cli/core';

const mocks = vi.hoisted(() => ({
  grantCapabilityTrust: vi.fn(),
  readDeclaredCapabilityPackageMetadata: vi.fn(),
  resolvePackageDir: vi.fn(),
  revokeCapabilityTrust: vi.fn(),
}));

vi.mock('@opensip-cli/config', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>();
  return {
    ...actual,
    grantCapabilityTrust: mocks.grantCapabilityTrust,
    revokeCapabilityTrust: mocks.revokeCapabilityTrust,
  };
});

vi.mock('@opensip-cli/core', async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    readDeclaredCapabilityPackageMetadata: mocks.readDeclaredCapabilityPackageMetadata,
    resolvePackageDir: mocks.resolvePackageDir,
  };
});

const PROJECT_CONTEXT: ProjectContext = {
  cwd: '/workspace',
  cwdExplicit: false,
  projectRoot: '/workspace',
  configPath: '/workspace/opensip-cli.config.yml',
  walkedUp: 0,
  scope: 'project',
};

function context() {
  const exitCodes: number[] = [];
  const ctx = {
    setExitCode: (code: number) => {
      exitCodes.push(code);
    },
  } as unknown as CliCommandsContext;
  return { ctx, exitCodes };
}

function projectScope(audit = new PolicyAuditCollector('run_policy')) {
  return {
    audit,
    scope: new RunScope({
      projectContext: PROJECT_CONTEXT,
      policyAudit: audit,
    }),
  };
}

beforeEach(() => {
  mocks.grantCapabilityTrust.mockReset();
  mocks.readDeclaredCapabilityPackageMetadata.mockReset();
  mocks.resolvePackageDir.mockReset().mockReturnValue('/workspace/node_modules/@acme/rules');
  mocks.revokeCapabilityTrust.mockReset();
});

describe('executePolicyTrust', () => {
  it('rejects a path-like package name before package resolution', () => {
    const { ctx, exitCodes } = context();
    const { scope, audit } = projectScope();

    const result = runWithScopeSync(scope, () => executePolicyTrust('../rules', ctx));

    expect(result).toEqual({
      type: 'error',
      message: "Invalid package name '../rules'.",
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    });
    expect(exitCodes).toEqual([EXIT_CODES.CONFIGURATION_ERROR]);
    expect(mocks.resolvePackageDir).not.toHaveBeenCalled();
    expect(audit.list()).toEqual([]);
  });

  it('requires a resolved project root', () => {
    const { ctx, exitCodes } = context();

    const result = runWithScopeSync(new RunScope({}), () => executePolicyTrust('@acme/rules', ctx));

    expect(result).toEqual({
      type: 'error',
      message: 'policy trust must run inside a project (no project root resolved).',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    });
    expect(exitCodes).toEqual([EXIT_CODES.CONFIGURATION_ERROR]);
    expect(mocks.resolvePackageDir).not.toHaveBeenCalled();
  });

  it('denies an installed-name grant when the package is not resolvable', () => {
    mocks.resolvePackageDir.mockReturnValue(undefined);
    const { ctx, exitCodes } = context();
    const { scope, audit } = projectScope();

    const result = runWithScopeSync(scope, () => executePolicyTrust('@acme/rules', ctx));

    expect(result).toEqual({
      type: 'error',
      message: "Package '@acme/rules' is not resolvable from /workspace — install it first.",
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    });
    expect(exitCodes).toEqual([EXIT_CODES.CONFIGURATION_ERROR]);
    expect(audit.list()).toMatchObject([
      {
        runId: 'run_policy',
        action: 'trust',
        subject: 'capability-pack:@acme/rules',
        outcome: 'deny',
        reasons: ['package not resolvable from the project'],
        metadata: {},
      },
    ]);
    expect(mocks.grantCapabilityTrust).not.toHaveBeenCalled();
  });

  it('denies a package that has no declared capability manifest', () => {
    mocks.readDeclaredCapabilityPackageMetadata.mockReturnValue({
      kind: 'tool',
    });
    const { ctx, exitCodes } = context();
    const { scope, audit } = projectScope();

    const result = runWithScopeSync(scope, () => executePolicyTrust('plain-package', ctx));

    expect(result).toEqual({
      type: 'error',
      message:
        "Package 'plain-package' declares no opensipTools capability manifest — nothing to trust.",
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    });
    expect(exitCodes).toEqual([EXIT_CODES.CONFIGURATION_ERROR]);
    expect(mocks.readDeclaredCapabilityPackageMetadata).toHaveBeenCalledWith(
      '/workspace/node_modules/@acme/rules',
    );
    expect(audit.list()).toMatchObject([
      {
        action: 'trust',
        subject: 'capability-pack:plain-package',
        outcome: 'deny',
        reasons: ['package declares no opensipTools capability manifest'],
        metadata: {},
      },
    ]);
    expect(mocks.grantCapabilityTrust).not.toHaveBeenCalled();
  });

  it('binds a trust grant and audit event to the resolved manifest hash', () => {
    const manifestHash = `sha256:${'a'.repeat(64)}`;
    mocks.readDeclaredCapabilityPackageMetadata.mockReturnValue({
      kind: 'tool-extension',
      manifestHash,
    });
    const { ctx, exitCodes } = context();
    const { scope, audit } = projectScope();

    const result = runWithScopeSync(scope, () => executePolicyTrust('@acme/rules', ctx));

    expect(result).toEqual({
      type: 'policy-trust',
      id: '@acme/rules',
      action: 'granted',
      manifestHash,
    });
    expect(exitCodes).toEqual([]);
    expect(mocks.grantCapabilityTrust).toHaveBeenCalledWith({
      id: '@acme/rules',
      manifestHash,
      grantedAt: expect.stringMatching(/^2026-|^20\d{2}-/u),
    });
    expect(audit.list()).toMatchObject([
      {
        runId: 'run_policy',
        action: 'trust',
        subject: 'capability-pack:@acme/rules',
        outcome: 'allow',
        sourceTier: 'user',
        reasons: ['operator granted capability trust'],
        exceptionIds: [],
        metadata: { manifestHash },
      },
    ]);
  });
});

describe('executePolicyUntrust', () => {
  it('rejects an invalid package name without mutating trust', () => {
    const { ctx, exitCodes } = context();

    const result = executePolicyUntrust('/absolute/package', ctx);

    expect(result).toEqual({
      type: 'error',
      message: "Invalid package name '/absolute/package'.",
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    });
    expect(exitCodes).toEqual([EXIT_CODES.CONFIGURATION_ERROR]);
    expect(mocks.revokeCapabilityTrust).not.toHaveBeenCalled();
  });

  it.each([
    [true, 'revoked', 'operator revoked capability trust'],
    [false, 'not-found', 'no grant existed'],
  ] as const)(
    'reports and audits whether an existing grant was removed',
    (removed, action, reason) => {
      mocks.revokeCapabilityTrust.mockReturnValue(removed);
      const { ctx, exitCodes } = context();
      const { scope, audit } = projectScope();

      const result = runWithScopeSync(scope, () => executePolicyUntrust('@acme/rules', ctx));

      expect(result).toEqual({
        type: 'policy-trust',
        id: '@acme/rules',
        action,
      });
      expect(exitCodes).toEqual([]);
      expect(mocks.revokeCapabilityTrust).toHaveBeenCalledWith('@acme/rules');
      expect(audit.list()).toMatchObject([
        {
          runId: 'run_policy',
          action: 'untrust',
          subject: 'capability-pack:@acme/rules',
          outcome: 'allow',
          reasons: [reason],
          metadata: {},
        },
      ]);
    },
  );
});
