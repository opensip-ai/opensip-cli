import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { isPathInside, toPosixRelative } from '@opensip-cli/core';

import { byCodePoint, deepFreeze } from './freeze.js';
import {
  MAX_COMMAND_ARGV,
  MAX_COMMAND_ARG_LENGTH,
  MAX_FACT_TEXT,
  MAX_MANIFEST_BINS,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_EXPORTS,
  MAX_PACKAGE_SCRIPTS,
  MAX_SCRIPT_NAME,
  MAX_WORKSPACE_PATTERNS,
} from './types.js';

import type {
  PackageManifestFacts,
  PackageManifestFactsResult,
  PackageManifestReadInput,
} from './types.js';
import type { VerificationCommand } from '@opensip-cli/contracts';

const CONTROL_CHARACTER = /\p{Cc}/u;
const ALLOWED_SCRIPT_NAME = /^(?:build|codegen|lint|test|typecheck)(?::[A-Za-z0-9._-]+)*$/u;
const ALLOWED_SCRIPT_FAMILY = /^(?:build|codegen|lint|test|typecheck)(?::|$)/u;
const SHELL_EXPRESSION = /(?:&&|\|\||[;&|><`$\\\n\r]|\(|\)|\{|\}|\[|\])/u;
const SECRET_TOKEN =
  /(?:^|[_-])(?:api[_-]?key|authorization|credential|password|secret|token)(?:$|[_=-])/iu;
const SAFE_ARG = /^[A-Za-z0-9@%_+./:=,-]+$/u;
const UNSAFE_EXACT_ARGS = new Set(['-u', '-w']);
const UNSAFE_LONG_FLAG_PREFIXES = [
  '--coverage',
  '--fix',
  '--host',
  '--interactive',
  '--open',
  '--registry',
  '--remote',
  '--ui',
  '--update',
  '--update-snapshot',
  '--update-snapshots',
  '--updatesnapshot',
  '--updatesnapshots',
  '--url',
  '--watch',
  '--watch-all',
  '--watchall',
  '--write',
] as const;
const SAFE_DIRECT_EXECUTABLES = new Set([
  'ava',
  'ctest',
  'eslint',
  'jest',
  'mocha',
  'mypy',
  'pytest',
  'pyright',
  'ruff',
  'tsc',
  'vitest',
]);
const SAFE_PYTHON_MODULES = new Set(['mypy', 'pytest', 'ruff', 'unittest']);

interface StringProjection {
  readonly values: readonly string[];
  readonly capped: boolean;
}

type ManifestFailure = Exclude<PackageManifestFactsResult, { ok: true }>;

interface PreparedManifestRead {
  readonly ok: true;
  readonly projectRoot: string;
  readonly packageRoot: string;
  readonly manifestPath: string;
}

type PreparedManifestResult = PreparedManifestRead | ManifestFailure;
type ManifestTextResult = { readonly ok: true; readonly raw: string } | ManifestFailure;
type ManifestRecordResult =
  { readonly ok: true; readonly record: Readonly<Record<string, unknown>> } | ManifestFailure;

function boundedPositive(value: number | undefined, hardMaximum: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return hardMaximum;
  return Math.min(Math.floor(value), hardMaximum);
}

function safeText(value: unknown, maximum = MAX_FACT_TEXT): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !CONTROL_CHARACTER.test(value)
  );
}

function projectStrings(values: readonly unknown[], limit: number): StringProjection {
  const unique = new Set<string>();
  let capped = false;
  for (const value of values) {
    if (!safeText(value)) continue;
    if (unique.size >= limit && !unique.has(value)) {
      capped = true;
      continue;
    }
    unique.add(value);
  }
  return { values: [...unique].sort(byCodePoint), capped };
}

function exportProjection(value: unknown): {
  readonly exports: readonly string[];
  readonly mapKeys?: readonly string[];
  readonly capped: boolean;
  readonly invalid: boolean;
} {
  if (typeof value === 'string' || Array.isArray(value)) {
    return { exports: ['.'], capped: false, invalid: false };
  }
  if (typeof value !== 'object' || value === null) {
    return { exports: [], capped: false, invalid: false };
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return { exports: [], mapKeys: [], capped: false, invalid: false };
  const subpaths = keys.filter((key) => key === '.' || key.startsWith('./'));
  if (subpaths.length === 0) {
    return { exports: ['.'], capped: false, invalid: false };
  }
  const invalid = subpaths.length !== keys.length || subpaths.some((key) => !safeText(key));
  const complete = invalid ? undefined : [...new Set(subpaths)].sort(byCodePoint);
  const projected = projectStrings(subpaths, MAX_MANIFEST_EXPORTS);
  return {
    exports: projected.values,
    ...(complete === undefined ? {} : { mapKeys: complete }),
    capped: projected.capped,
    invalid,
  };
}

function binProjection(value: unknown, packageName: string): StringProjection {
  if (typeof value === 'string') {
    const command = packageName.startsWith('@') ? packageName.split('/')[1] : packageName;
    return projectStrings(command === undefined ? [] : [command], MAX_MANIFEST_BINS);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { values: [], capped: false };
  }
  return projectStrings(Object.keys(value), MAX_MANIFEST_BINS);
}

function workspaceProjection(value: unknown): StringProjection {
  if (Array.isArray(value)) return projectStrings(value, MAX_WORKSPACE_PATTERNS);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { values: [], capped: false };
  }
  const packages = (value as Record<string, unknown>).packages;
  return Array.isArray(packages)
    ? projectStrings(packages, MAX_WORKSPACE_PATTERNS)
    : { values: [], capped: false };
}

function allowlistedCommand(tokens: readonly string[]): boolean {
  const executable = tokens[0];
  const verb = tokens[1];
  if (executable === undefined) return false;
  if (SAFE_DIRECT_EXECUTABLES.has(executable)) return true;
  if (executable === 'python' || executable === 'python3') {
    return verb === '-m' && tokens[2] !== undefined && SAFE_PYTHON_MODULES.has(tokens[2]);
  }
  if (executable === 'go') return verb === 'test' || verb === 'vet';
  if (executable === 'cargo') return verb === 'check' || verb === 'clippy' || verb === 'test';
  if (executable === 'mvn' || executable === 'mvnw' || executable === './mvnw') {
    return verb === 'package' || verb === 'test' || verb === 'verify';
  }
  if (executable === 'gradle' || executable === 'gradlew' || executable === './gradlew') {
    return verb === 'build' || verb === 'check' || verb === 'test';
  }
  return false;
}

function safeArgToken(token: string): boolean {
  if (
    token.length === 0 ||
    token.length > MAX_COMMAND_ARG_LENGTH ||
    !SAFE_ARG.test(token) ||
    unsafeVerificationArg(token) ||
    SECRET_TOKEN.test(token)
  )
    return false;
  const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : token;
  if (value.startsWith('/') || /^[A-Za-z]:\//u.test(value)) return false;
  return !value.split('/').includes('..');
}

function unsafeVerificationArg(token: string): boolean {
  const normalized = token.toLowerCase();
  if (UNSAFE_EXACT_ARGS.has(normalized)) return true;
  return UNSAFE_LONG_FLAG_PREFIXES.some(
    (prefix) =>
      normalized === prefix ||
      normalized.startsWith(`${prefix}=`) ||
      normalized.startsWith(`${prefix}.`),
  );
}

function safeScriptArgv(raw: unknown): readonly string[] | undefined {
  if (!safeText(raw) || SHELL_EXPRESSION.test(raw) || SECRET_TOKEN.test(raw)) return undefined;
  const tokens = raw.trim().split(/\s+/u);
  if (tokens.length === 0 || tokens.length > MAX_COMMAND_ARGV) return undefined;
  if (tokens.some((token) => !safeArgToken(token))) return undefined;
  return allowlistedCommand(tokens) ? tokens : undefined;
}

function commandTier(name: string, packageRoot: string): VerificationCommand['tier'] {
  if (name.includes(':')) return 'focused';
  return packageRoot === '.' ? 'full' : 'package';
}

function verificationCommands(
  value: unknown,
  packageRoot: string,
  maximum: number,
): {
  readonly commands: readonly VerificationCommand[];
  readonly reasons: readonly string[];
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { commands: [], reasons: [] };
  }
  const reasons = new Set<string>();
  const entries: [string, unknown][] = [];
  for (const entry of Object.entries(value)) {
    const [name] = entry;
    if (!ALLOWED_SCRIPT_FAMILY.test(name)) continue;
    if (!safeText(name, MAX_SCRIPT_NAME) || !ALLOWED_SCRIPT_NAME.test(name)) {
      reasons.add('manifest-script-invalid');
      continue;
    }
    entries.push(entry);
  }
  entries.sort(([left], [right]) => byCodePoint(left, right));
  if (entries.length > maximum) reasons.add('manifest-script-cap-reached');
  const commands: VerificationCommand[] = [];
  for (const [name, raw] of entries.slice(0, maximum)) {
    const argv = safeScriptArgv(raw);
    if (argv === undefined) {
      reasons.add('manifest-script-unsafe');
      continue;
    }
    commands.push(
      deepFreeze({
        tier: commandTier(name, packageRoot),
        cwd: packageRoot,
        argv: [...argv],
        basis: `manifest-script:${name}`,
      }),
    );
  }
  return { commands, reasons: [...reasons].sort(byCodePoint) };
}

function failure(reason: ManifestFailure['reason']): ManifestFailure {
  return deepFreeze({ ok: false as const, reason });
}

function prepareManifestRead(input: PackageManifestReadInput): PreparedManifestResult {
  if (input.signal?.aborted) return failure('cancelled');
  if (input.projectRoot.length === 0 || input.packageRoot.length === 0) {
    return failure('invalid-input');
  }
  let projectRoot: string;
  let packageRoot: string;
  try {
    projectRoot = realpathSync(input.projectRoot);
    packageRoot = realpathSync(input.packageRoot);
  } catch {
    return failure('read-failed');
  }
  if (!isPathInside(packageRoot, projectRoot)) return failure('outside-root');
  const lexicalManifestPath = join(packageRoot, 'package.json');
  let manifestPath: string;
  try {
    manifestPath = realpathSync(lexicalManifestPath);
  } catch {
    return failure('read-failed');
  }
  if (!isPathInside(manifestPath, projectRoot)) return failure('outside-root');
  const root = toPosixRelative(projectRoot, packageRoot) || '.';
  if (
    root.length > 1024 ||
    CONTROL_CHARACTER.test(root) ||
    (root !== '.' &&
      root.split('/').some((part) => part.length === 0 || part === '.' || part === '..'))
  ) {
    return failure('path-invalid');
  }
  return { ok: true, projectRoot, packageRoot, manifestPath };
}

function readManifestText(manifestPath: string, maximumBytes: number): ManifestTextResult {
  let raw: string;
  try {
    if (statSync(manifestPath).size > maximumBytes) return failure('too-large');
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    return failure('read-failed');
  }
  return Buffer.byteLength(raw, 'utf8') > maximumBytes ? failure('too-large') : { ok: true, raw };
}

function parseManifestRecord(raw: string): ManifestRecordResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failure('parse-failed');
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? { ok: true, record: parsed as Record<string, unknown> }
    : failure('invalid-shape');
}

/**
 * Read one package manifest through a bounded, containment-checked projection.
 * Raw JSON, script strings, manifest values, paths, and exceptions never cross
 * this boundary.
 */
export function readPackageManifestFacts(
  input: PackageManifestReadInput,
): PackageManifestFactsResult {
  const prepared = prepareManifestRead(input);
  if (!prepared.ok) return prepared;
  const maximumBytes = boundedPositive(input.maxBytes, MAX_MANIFEST_BYTES);
  const text = readManifestText(prepared.manifestPath, maximumBytes);
  if (!text.ok) return text;
  if (input.signal?.aborted) return failure('cancelled');
  const parsed = parseManifestRecord(text.raw);
  if (!parsed.ok) return parsed;
  const { record } = parsed;
  if (!safeText(record.name, 214)) return failure('invalid-shape');

  const root = toPosixRelative(prepared.projectRoot, prepared.packageRoot) || '.';
  const exportsProjection = exportProjection(record.exports);
  const bins = binProjection(record.bin, record.name);
  const workspaces = workspaceProjection(record.workspaces);
  const scripts = verificationCommands(
    record.scripts,
    root,
    boundedPositive(input.maxScripts, MAX_PACKAGE_SCRIPTS),
  );
  const reasons = new Set(scripts.reasons);
  if (exportsProjection.capped) reasons.add('manifest-export-cap-reached');
  if (exportsProjection.invalid) reasons.add('manifest-export-invalid');
  if (bins.capped) reasons.add('manifest-bin-cap-reached');
  if (workspaces.capped) reasons.add('manifest-workspace-cap-reached');

  const facts: PackageManifestFacts = {
    name: record.name,
    root,
    private: record.private === true,
    exports: [...exportsProjection.exports],
    ...(exportsProjection.mapKeys === undefined
      ? {}
      : { exportMapKeys: [...exportsProjection.mapKeys] }),
    bins: [...bins.values],
    verificationCommands: [...scripts.commands],
    ...(safeText(record.packageManager, 128) ? { packageManager: record.packageManager } : {}),
    workspacePatterns: [...workspaces.values],
    reasonCodes: [...reasons].sort(byCodePoint),
  };
  return deepFreeze({ ok: true as const, facts: deepFreeze(facts) });
}
