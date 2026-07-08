// @fitness-ignore-file shipped-checks-must-be-generic -- opensip-internal dogfood check (ADR-0140): self-targeting adapter package contract; inert for adopters.
/**
 * @fileoverview External Tool Adapter package contract.
 *
 * ADR-0140/ADR-0090 make scanner adapters ordinary Tool packages authored through
 * defineExternalToolAdapter. The substrate owns binary resolution, subprocess
 * execution, doctor/version commands, redaction, evidence delivery, and session /
 * baseline host seams. This check is self-targeting: it only inspects packages
 * whose manifest declares a Tool and whose dependencies include
 * @opensip-cli/external-tool-adapter.
 */

import path from 'node:path';

import { isRecord, mapWithConcurrency } from '@opensip-cli/core';
import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-cli/fitness';

const ADAPTER_DEP = '@opensip-cli/external-tool-adapter';
const NON_RUNTIME_SOURCE = /(?:\.d\.ts$|\.test\.tsx?$|\/__tests__\/)/;
const CHILD_PROCESS_IMPORT =
  /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"](?:node:)?child_process['"]/;
const SUBPROCESS_CALL = /\b(?:execFile|execFileSync|spawn|spawnSync)\s*\(/;
const DEFINE_TOOL = /\bdefineTool\b/;
const SESSION_REPO_SYMBOL = 'Session' + 'Repo';
const FORBIDDEN_PERSISTENCE_IMPORT =
  /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]@opensip-cli\/(?:datastore|session-store)['"]/;
const FORBIDDEN_PROCESS_OUTPUT =
  /\b(?:process\.(?:stdout|stderr)\.write|console\.(?:log|error|warn)|process\.exit)\s*\(/;

interface PackageJson {
  readonly name?: unknown;
  readonly dependencies?: Record<string, unknown>;
  readonly devDependencies?: Record<string, unknown>;
  readonly peerDependencies?: Record<string, unknown>;
  readonly opensipTools?: ToolManifest;
}

interface ToolManifest {
  readonly kind?: unknown;
  readonly id?: unknown;
  readonly commands?: unknown;
  readonly requires?: unknown;
  readonly config?: unknown;
}

interface AdapterPackage {
  readonly packageJsonPath: string;
  readonly packageDir: string;
  readonly name: string;
  readonly manifest: ToolManifest;
}

type Quote = '"' | "'" | '`';

function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function hasDependency(pkg: PackageJson, name: string): boolean {
  return (
    pkg.dependencies?.[name] !== undefined ||
    pkg.devDependencies?.[name] !== undefined ||
    pkg.peerDependencies?.[name] !== undefined
  );
}

function commandArray(manifest: ToolManifest): Record<string, unknown>[] {
  return Array.isArray(manifest.commands) ? manifest.commands.filter(isRecord) : [];
}

function configNamespace(config: unknown): string | undefined {
  return isRecord(config) && typeof config.namespace === 'string' && config.namespace.length > 0
    ? config.namespace
    : undefined;
}

function requiredResources(requires: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(requires)) return out;
  for (const entry of requires) {
    if (isRecord(entry) && typeof entry.resource === 'string') out.add(entry.resource);
  }
  return out;
}

function violation(
  adapter: AdapterPackage,
  message: string,
  type: string,
  filePath = adapter.packageJsonPath,
): CheckViolation {
  return {
    filePath,
    line: 1,
    message: `${adapter.name}: ${message}`,
    severity: 'error',
    suggestion:
      'Author external scanner packages through defineExternalToolAdapter and keep runtime effects on the substrate/host seams: no hand-rolled subprocesses, output, sessions, or baselines.',
    type,
  };
}

/**
 * Strip comments while preserving strings/templates so import specifier strings
 * remain matchable but prose comments do not produce false positives.
 */
function stripComments(source: string): string {
  let out = '';
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quoted = readQuoted(source, i, ch);
      out += quoted.text;
      i = quoted.next;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      i = skipLineComment(source, i);
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i = skipBlockComment(source, i);
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function readQuoted(
  source: string,
  start: number,
  quote: Quote,
): { readonly text: string; readonly next: number } {
  let text = quote;
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i] ?? '';
    text += ch;
    if (ch === '\\' && i + 1 < source.length) {
      text += source[i + 1] ?? '';
      i += 2;
      continue;
    }
    i += 1;
    if (ch === quote) break;
  }
  return { text, next: i };
}

function skipLineComment(source: string, start: number): number {
  let i = start;
  while (i < source.length && source[i] !== '\n') i += 1;
  return i;
}

function skipBlockComment(source: string, start: number): number {
  let i = start + 2;
  while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
  return i + 2;
}

function checkManifest(adapter: AdapterPackage): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const commands = commandArray(adapter.manifest);
  const resources = requiredResources(adapter.manifest.requires);
  if (configNamespace(adapter.manifest.config) === undefined) {
    violations.push(
      violation(
        adapter,
        'external adapters must declare opensipTools.config.namespace',
        'external-adapter-config',
      ),
    );
  }
  for (const resource of ['subprocess', 'filesystem']) {
    if (!resources.has(resource)) {
      violations.push(
        violation(
          adapter,
          `external adapters must declare a ${resource} requirement`,
          'external-adapter-requires',
        ),
      );
    }
  }
  if (commands.some((cmd) => cmd.output === 'live-view')) {
    violations.push(
      violation(
        adapter,
        "external adapter commands must not declare output 'live-view'",
        'external-adapter-live-view-output',
      ),
    );
  }
  if (!commands.some((cmd) => cmd.name === 'doctor')) {
    violations.push(
      violation(
        adapter,
        'external adapters must expose a doctor command',
        'external-adapter-doctor',
      ),
    );
  }
  if (!commands.some((cmd) => cmd.name === 'version')) {
    violations.push(
      violation(
        adapter,
        'external adapters must expose a version command',
        'external-adapter-version',
      ),
    );
  }
  return violations;
}

function sourcePathsFor(files: FileAccessor, adapter: AdapterPackage): string[] {
  const root = `${normalizePath(adapter.packageDir)}/src/`;
  return files.paths
    .map(normalizePath)
    .filter((filePath) => filePath.startsWith(root))
    .filter((filePath) => filePath.endsWith('.ts') || filePath.endsWith('.tsx'))
    .filter((filePath) => !NON_RUNTIME_SOURCE.test(filePath));
}

async function checkSource(
  files: FileAccessor,
  adapter: AdapterPackage,
): Promise<CheckViolation[]> {
  const violations: CheckViolation[] = [];
  const sourcePaths = sourcePathsFor(files, adapter);
  let usesSubstrate = false;
  for (const sourcePath of sourcePaths) {
    const source = stripComments(await files.read(sourcePath));
    if (/\bdefineExternalToolAdapter\b/.test(source)) usesSubstrate = true;
    if (CHILD_PROCESS_IMPORT.test(source) || SUBPROCESS_CALL.test(source)) {
      violations.push(
        violation(
          adapter,
          'external adapter runtime source must not import/call child_process directly',
          'external-adapter-subprocess',
          sourcePath,
        ),
      );
    }
    if (DEFINE_TOOL.test(source)) {
      violations.push(
        violation(
          adapter,
          'external adapter runtime source must use defineExternalToolAdapter, not raw defineTool',
          'external-adapter-define-tool',
          sourcePath,
        ),
      );
    }
    if (
      FORBIDDEN_PERSISTENCE_IMPORT.test(source) ||
      new RegExp(`\\b${SESSION_REPO_SYMBOL}\\b`).test(source)
    ) {
      violations.push(
        violation(
          adapter,
          'external adapter runtime source must not import datastore/session persistence',
          'external-adapter-persistence',
          sourcePath,
        ),
      );
    }
    if (FORBIDDEN_PROCESS_OUTPUT.test(source)) {
      violations.push(
        violation(
          adapter,
          'external adapter runtime source must not write process output or exit directly',
          'external-adapter-output',
          sourcePath,
        ),
      );
    }
  }
  if (!usesSubstrate) {
    violations.push(
      violation(
        adapter,
        'external adapter package must build its Tool through defineExternalToolAdapter',
        'external-adapter-substrate',
      ),
    );
  }
  return violations;
}

function adapterFromPackageJson(filePath: string, raw: string): AdapterPackage | undefined {
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(raw) as PackageJson;
  } catch {
    // @fitness-ignore-next-line error-handling-quality -- malformed package.json rows are skipped; JSON validity is owned elsewhere
    return undefined;
  }
  if (pkg.opensipTools?.kind !== 'tool' || !hasDependency(pkg, ADAPTER_DEP)) return undefined;
  return {
    packageJsonPath: normalizePath(filePath),
    packageDir: normalizePath(path.dirname(filePath)),
    name: adapterName(pkg, filePath),
    manifest: pkg.opensipTools,
  };
}

function adapterName(pkg: PackageJson, filePath: string): string {
  if (typeof pkg.name === 'string' && pkg.name.length > 0) return pkg.name;
  if (typeof pkg.opensipTools?.id === 'string') return pkg.opensipTools.id;
  return filePath;
}

const ADAPTER_SCAN_CONCURRENCY = 8;

export async function analyzeExternalToolAdapterContracts(
  files: FileAccessor,
): Promise<CheckViolation[]> {
  const packageJsonPaths = files.paths.filter((filePath) => path.basename(filePath) === 'package.json');
  const adapters = (
    await mapWithConcurrency(packageJsonPaths, ADAPTER_SCAN_CONCURRENCY, async (filePath) =>
      adapterFromPackageJson(filePath, await files.read(filePath)),
    )
  ).filter((adapter): adapter is AdapterPackage => adapter !== undefined);

  const perAdapter = await mapWithConcurrency(adapters, ADAPTER_SCAN_CONCURRENCY, async (adapter) => [
    ...checkManifest(adapter),
    ...(await checkSource(files, adapter)),
  ]);
  return perAdapter.flat();
}

export const externalToolAdapterContract = defineCheck({
  id: '20f87feb-8328-4959-a93d-78ee3e076ef9',
  slug: 'external-tool-adapter-contract',
  description:
    'External Tool Adapter packages must use defineExternalToolAdapter and delegate subprocess, output, session, and baseline effects to the substrate/host seams',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture', 'adapters'],
  contentFilter: 'raw',
  analyzeAll: analyzeExternalToolAdapterContracts,
});
