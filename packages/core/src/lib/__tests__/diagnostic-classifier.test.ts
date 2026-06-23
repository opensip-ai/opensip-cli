/**
 * diagnostic-classifier — path scrubbing, module-error classification, and
 * integrity-failure patterns (ADR-0060, Phase 2).
 */

import { describe, it, expect } from 'vitest';

import { CLI_DIAGNOSTIC_CODES } from '../cli-diagnostic.js';
import {
  classifyIntegrityFailure,
  classifyModuleError,
  detectIntegrityFailure,
  scrubModuleNotFoundMessage,
  scrubModuleNotFoundPath,
} from '../diagnostic-classifier.js';

const ABS_CORE_IDENTITY =
  "Cannot find module '/Users/dev/proj/node_modules/.pnpm/@opensip-cli+core@0.1.11/node_modules/@opensip-cli/core/dist/tools/identity.js' imported from /Users/dev/proj/packages/cli/dist/index.js";

describe('scrubModuleNotFoundPath', () => {
  it('reduces an absolute node_modules path to a package-relative coordinate', () => {
    expect(
      scrubModuleNotFoundPath(
        '/Users/dev/proj/node_modules/@opensip-cli/core/dist/tools/identity.js',
      ),
    ).toBe('@opensip-cli/core/dist/tools/identity.js');
  });

  it('reduces a pnpm injected virtual-store path to a package-relative coordinate', () => {
    expect(
      scrubModuleNotFoundPath(
        '/Users/dev/proj/node_modules/.pnpm/@opensip-cli+core@0.1.11/node_modules/@opensip-cli/core/dist/tools/identity.js',
      ),
    ).toBe('@opensip-cli/core/dist/tools/identity.js');
  });

  it('scrubs unknown absolute paths to a sentinel', () => {
    expect(scrubModuleNotFoundPath('/etc/passwd')).toBe('<path-scrubbed>');
  });
});

describe('scrubModuleNotFoundMessage', () => {
  it('scrubs absolute paths in ERR_MODULE_NOT_FOUND messages', () => {
    expect(scrubModuleNotFoundMessage(ABS_CORE_IDENTITY)).toBe(
      "Cannot find module '@opensip-cli/core/dist/tools/identity.js' imported from <path-scrubbed>",
    );
  });
});

describe('classifyModuleError', () => {
  it('classifies ERR_MODULE_NOT_FOUND with scrubbed message and no absolute path leak', () => {
    const error = Object.assign(new Error(ABS_CORE_IDENTITY), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const diag = classifyModuleError(error, {
      packageName: '@opensip-cli/core',
      toolId: 'fit',
    });

    expect(diag.code).toBe(CLI_DIAGNOSTIC_CODES.OPENSIP_INTEGRITY_INJECTED_COPY_STALE);
    expect(diag.category).toBe('integrity');
    expect(diag.message).not.toContain('/Users/');
    expect(diag.provenance).toEqual(
      expect.objectContaining({
        packageName: '@opensip-cli/core',
        toolId: 'fit',
      }),
    );
  });

  it('classifies a generic loader throw as a discovery load failure', () => {
    const diag = classifyModuleError(new Error('export `tool` is not defined'));

    expect(diag.code).toBe(CLI_DIAGNOSTIC_CODES.OPENSIP_DISCOVERY_TOOL_LOAD_FAILED);
    expect(diag.category).toBe('runtime');
    expect(diag.severity).toBe('error');
  });
});

describe('classifyIntegrityFailure', () => {
  it('maps injected-copy-stale to rebuild/reinstall guidance', () => {
    const diag = classifyIntegrityFailure({
      kind: 'injected-copy-stale',
      packageName: '@opensip-cli/core',
      expectedEntry: '@opensip-cli/core/dist/tools/identity.js',
    });

    expect(diag?.code).toBe(CLI_DIAGNOSTIC_CODES.OPENSIP_INTEGRITY_INJECTED_COPY_STALE);
    expect(diag?.action).toContain('pnpm build');
    expect(diag?.action).toContain('pnpm-workspace-state-v1.json');
    expect(diag?.impact).toContain('stale injected copy');
  });

  it('maps missing-dist-entry to a build artifact diagnostic', () => {
    const diag = classifyIntegrityFailure({
      kind: 'missing-dist-entry',
      packageName: '@opensip-cli/fitness',
      expectedEntry: 'dist/index.js',
    });

    expect(diag?.code).toBe(CLI_DIAGNOSTIC_CODES.OPENSIP_INTEGRITY_MISSING_DIST_ENTRY);
    expect(diag?.category).toBe('integrity');
  });
});

describe('detectIntegrityFailure', () => {
  it('detects stale injected-copy patterns from a module-not-found throw', () => {
    const error = Object.assign(new Error(ABS_CORE_IDENTITY), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const detected = detectIntegrityFailure(error, {
      packageName: '@opensip-cli/core',
    });

    expect(detected?.kind).toBe('injected-copy-stale');
    expect(detected?.packageName).toBe('@opensip-cli/core');
    expect(detected?.expectedEntry).toBe('@opensip-cli/core/dist/tools/identity.js');
  });
});
