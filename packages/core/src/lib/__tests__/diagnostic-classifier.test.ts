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

  it('scrubs a quoted absolute importer path', () => {
    expect(
      scrubModuleNotFoundMessage(
        `Cannot find module '@opensip-cli/missing' imported from "/Users/dev/proj/loader.js"`,
      ),
    ).toContain('imported from "<path-scrubbed>"');
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

  it('classifies module-not-found from the message when code is absent', () => {
    const diag = classifyModuleError(
      new Error("Cannot find module '@opensip-cli/missing' imported from ./loader.js"),
    );

    expect(diag.code).toBe(CLI_DIAGNOSTIC_CODES.OPENSIP_RUNTIME_MODULE_NOT_FOUND);
    expect(diag.message).toContain("Cannot find module '@opensip-cli/missing'");
  });

  it('retains scrubbed detail for an absolute non-workspace module miss', () => {
    const diag = classifyModuleError(
      new Error("Cannot find module '/Users/dev/private/missing.js'"),
    );

    expect(diag.code).toBe(CLI_DIAGNOSTIC_CODES.OPENSIP_RUNTIME_MODULE_NOT_FOUND);
    expect(diag.message).toContain('<path-scrubbed>');
    expect(diag.detail).toContain('/Users/dev/private/missing.js');
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

  it('supports omitted entry hints and rejects unknown integrity kinds', () => {
    expect(
      classifyIntegrityFailure({
        kind: 'missing-dist-entry',
        packageName: '@opensip-cli/fitness',
      })?.message,
    ).toBe('Package @opensip-cli/fitness is missing a required build artifact.');
    expect(
      classifyIntegrityFailure({
        kind: 'future-integrity-kind',
        packageName: '@opensip-cli/core',
      } as never),
    ).toBeUndefined();
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

  it('infers the package name and tolerates an absent missing-entry match', () => {
    const detected = detectIntegrityFailure(
      new Error(
        'ERR_MODULE_NOT_FOUND while loading node_modules/@opensip-cli/core from an injected copy',
      ),
    );

    expect(detected).toMatchObject({
      kind: 'injected-copy-stale',
      packageName: '@opensip-cli/core',
      expectedEntry: undefined,
    });
  });

  it('returns no integrity match for ordinary loader failures', () => {
    expect(detectIntegrityFailure(new Error('ordinary loader failure'))).toBeUndefined();
  });
});
