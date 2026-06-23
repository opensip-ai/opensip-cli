/**
 * diagnostic-classifier — pure classifiers that turn raw loader/discovery throws
 * into typed {@link CliDiagnostic}s (ADR-0060, Phase 2).
 *
 * Scrub absolute paths from `ERR_MODULE_NOT_FOUND` messages before they reach
 * user-facing renderers; map install/build-integrity failures to actionable
 * diagnostics that point at rebuild/reinstall rather than config edits.
 */

import {
  CLI_DIAGNOSTIC_CODES,
  type CliDiagnostic,
  type CliDiagnosticProvenance,
} from './cli-diagnostic.js';

/** Input for an integrity failure the host already diagnosed structurally. */
export interface IntegrityFailureInput {
  readonly kind: 'injected-copy-stale' | 'missing-dist-entry';
  readonly packageName: string;
  readonly expectedEntry?: string;
  readonly provenance?: CliDiagnosticProvenance;
}

const MODULE_NOT_FOUND_RE = /Cannot find module (['"])([^'"]+)\1/g;

const INJECTED_COPY_HINT = /node_modules\/\.pnpm\/@opensip-cli\+|node_modules\/@opensip-cli\//;

/**
 * Replace an absolute filesystem path in a module-resolution message with a
 * package-relative coordinate (`@scope/pkg/...`) or a scrubbed sentinel.
 */
export function scrubModuleNotFoundPath(path: string): string {
  const pnpmInjected =
    /node_modules\/\.pnpm\/@opensip-cli\+[^/]+\/node_modules\/(@opensip-cli\/[^/]+(?:\/.*)?)$/.exec(
      path,
    );
  if (pnpmInjected !== null) return pnpmInjected[1];

  const nodeModules = /(?:^|\/)node_modules\/((?:@[^/]+\/[^/]+|[^/]+)(?:\/.*)?)$/.exec(path);
  if (nodeModules !== null && !nodeModules[1].startsWith('.pnpm/')) return nodeModules[1];

  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return '<path-scrubbed>';
  return path;
}

const IMPORTED_FROM_QUOTED_RE = /imported from (['"])([^'"]+)\1/g;
const IMPORTED_FROM_BARE_RE = /imported from ([^\s]+)/g;

/** Scrub absolute paths out of a Node `ERR_MODULE_NOT_FOUND` message. */
export function scrubModuleNotFoundMessage(message: string): string {
  const withoutModulePath = message.replace(
    MODULE_NOT_FOUND_RE,
    (_match, quote: string, path: string) => {
      return `Cannot find module ${quote}${scrubModuleNotFoundPath(path)}${quote}`;
    },
  );
  const withoutQuotedImporter = withoutModulePath.replace(
    IMPORTED_FROM_QUOTED_RE,
    (_match, quote: string, path: string) => {
      return `imported from ${quote}${scrubModuleNotFoundPath(path)}${quote}`;
    },
  );
  return withoutQuotedImporter.replace(IMPORTED_FROM_BARE_RE, (_match, path: string) => {
    return `imported from ${scrubModuleNotFoundPath(path)}`;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isModuleNotFound(error: unknown, message: string): boolean {
  if (error instanceof Error && 'code' in error) {
    return (error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND';
  }
  return message.includes('ERR_MODULE_NOT_FOUND') || message.includes('Cannot find module');
}

/**
 * Classify a dynamic-import / loader throw into a typed runtime diagnostic.
 * Absolute paths in `ERR_MODULE_NOT_FOUND` messages are scrubbed.
 */
export function classifyModuleError(
  error: unknown,
  provenance?: CliDiagnosticProvenance,
): CliDiagnostic {
  const rawMessage = errorMessage(error);
  const scrubbed = scrubModuleNotFoundMessage(rawMessage);

  if (isModuleNotFound(error, rawMessage)) {
    const injected = INJECTED_COPY_HINT.test(rawMessage);
    if (injected) {
      const integrity = classifyIntegrityFailure({
        kind: 'injected-copy-stale',
        packageName: provenance?.packageName ?? 'workspace package',
        expectedEntry: extractMissingEntry(rawMessage),
        provenance,
      });
      if (integrity !== undefined) return integrity;
    }

    return {
      severity: 'error',
      code: CLI_DIAGNOSTIC_CODES.OPENSIP_RUNTIME_MODULE_NOT_FOUND,
      category: 'runtime',
      message: scrubbed,
      impact: 'A required module could not be resolved, so the command cannot run.',
      action: injected
        ? 'Rebuild the workspace and refresh injected copies: `pnpm build` then `rm -f node_modules/.pnpm-workspace-state-v1.json && pnpm install`.'
        : 'Verify the package is installed and its build output exists.',
      provenance,
      detail: rawMessage === scrubbed ? undefined : rawMessage,
    };
  }

  return {
    severity: 'error',
    code: CLI_DIAGNOSTIC_CODES.OPENSIP_DISCOVERY_TOOL_LOAD_FAILED,
    category: 'runtime',
    message: scrubbed,
    impact: 'A bootstrap loader failed, so the selected command may be incomplete.',
    provenance,
    detail: rawMessage === scrubbed ? undefined : rawMessage,
  };
}

function extractMissingEntry(message: string): string | undefined {
  const match = /Cannot find module ['"]([^'"]+)['"]/.exec(message);
  const path = match?.[1];
  if (path === undefined) return undefined;
  return scrubModuleNotFoundPath(path);
}

/**
 * Classify a known install/build-integrity failure into a typed diagnostic.
 * Returns `undefined` when the input does not match a supported integrity pattern.
 */
export function classifyIntegrityFailure(input: IntegrityFailureInput): CliDiagnostic | undefined {
  const { kind, packageName, expectedEntry, provenance } = input;

  if (kind === 'injected-copy-stale') {
    const entryHint = expectedEntry === undefined ? '' : ` (missing ${expectedEntry})`;
    return {
      severity: 'error',
      code: CLI_DIAGNOSTIC_CODES.OPENSIP_INTEGRITY_INJECTED_COPY_STALE,
      category: 'integrity',
      message: `Injected workspace copy of ${packageName} is stale or incomplete${entryHint}.`,
      impact:
        'The CLI resolved a stale injected copy of a first-party package, so bootstrap cannot load required runtime files.',
      action:
        'Rebuild and refresh injected copies: `pnpm build` then `rm -f node_modules/.pnpm-workspace-state-v1.json && pnpm install`.',
      provenance: { packageName, ...provenance },
    };
  }

  if (kind === 'missing-dist-entry') {
    const entryHint = expectedEntry === undefined ? '' : ` (${expectedEntry})`;
    return {
      severity: 'error',
      code: CLI_DIAGNOSTIC_CODES.OPENSIP_INTEGRITY_MISSING_DIST_ENTRY,
      category: 'integrity',
      message: `Package ${packageName} is missing a required build artifact${entryHint}.`,
      impact: 'A required dist entry point is absent, so the tool runtime cannot load.',
      action: 'Build the package (`pnpm build`) and reinstall or refresh workspace injection.',
      provenance: { packageName, ...provenance },
    };
  }

  return undefined;
}

/**
 * Detect integrity-failure patterns in a raw error message. Returns structured
 * input for {@link classifyIntegrityFailure} when a known pattern matches.
 */
export function detectIntegrityFailure(
  error: unknown,
  provenance?: CliDiagnosticProvenance,
): IntegrityFailureInput | undefined {
  const message = errorMessage(error);
  if (!isModuleNotFound(error, message) || !INJECTED_COPY_HINT.test(message)) {
    return undefined;
  }

  return {
    kind: 'injected-copy-stale',
    packageName: provenance?.packageName ?? inferPackageName(message) ?? 'workspace package',
    expectedEntry: extractMissingEntry(message),
    provenance,
  };
}

function inferPackageName(message: string): string | undefined {
  const scoped = /@opensip-cli\/[^/'"\s]+/.exec(message);
  return scoped?.[0];
}
