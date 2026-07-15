import { createHash } from 'node:crypto';

import { z } from 'zod';

import { compareCodePoint as compareCodePoints } from './code-point-order.js';
import { MAX_TASK_CONTEXT_FILES } from './task-context-model.js';

import type { TaskContextFileScope } from './task-context-model.js';

export const safeText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !/\p{Cc}/u.test(value));
export const reasonCodeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i);
export const relativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !/^[A-Za-z]:/.test(value) &&
      !value.includes('\\') &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
  );
export const rootPathSchema = z.union([z.literal('.'), relativePathSchema]);
export const inventoryIdentitySchema = z.string().regex(/^i1:[a-f0-9]{64}$/u);
export const inventoryMetadataIdentitySchema = z.string().regex(/^m1:[a-f0-9]{64}$/u);
export const testSelectionIdentitySchema = z.string().regex(/^ts1:[a-f0-9]{64}$/u);
export const graphIdentitySchema = z.string().regex(/^g1:[a-f0-9]{64}$/u);
export const sha256IdentitySchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const gitObjectIdentitySchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
export const taskContextRunIdSchema = z.string().regex(/^RUN_[0-9A-HJKMNP-TV-Z]{26}$/u);
export const taskContextStepIdSchema = z.string().regex(/^STEP_[0-9A-HJKMNP-TV-Z]{26}$/u);
export const taskContextFollowUpReadSchema = z.enum([
  'get_context_status',
  'get_file_context',
  'get_symbol',
  'impact_files',
  'select_tests',
]);
export const taskContextNextActionSchema = z.enum([
  'get_context_status',
  'get_file_context',
  'impact_files',
  'select_tests',
  'opensip suite run agent-context --json',
  'opensip suite run agent-context --files <same-explicit-files> --json',
]);
export const contextPointerIdentitySchema = z.union([
  inventoryIdentitySchema,
  testSelectionIdentitySchema,
  graphIdentitySchema,
]);

const safeVerificationToken = /^[A-Za-z0-9@%_+./:=,-]+$/u;
const unsafeExactVerificationArgs = new Set(['-u', '-w']);
const unsafeLongVerificationFlagPrefixes = [
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
const secretVerificationToken =
  /(?:^|[_-])(?:api[_-]?key|authorization|credential|password|secret|token)(?:$|[_=-])/iu;
const directVerificationExecutables = new Set([
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
const pythonVerificationModules = new Set(['mypy', 'pytest', 'ruff', 'unittest']);

function unsafeVerificationArgument(token: string): boolean {
  const normalized = token.toLowerCase();
  if (unsafeExactVerificationArgs.has(normalized)) return true;
  return unsafeLongVerificationFlagPrefixes.some(
    (prefix) =>
      normalized === prefix ||
      normalized.startsWith(`${prefix}=`) ||
      normalized.startsWith(`${prefix}.`),
  );
}

function safeVerificationArg(token: string): boolean {
  if (
    !safeVerificationToken.test(token) ||
    unsafeVerificationArgument(token) ||
    secretVerificationToken.test(token)
  ) {
    return false;
  }
  const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : token;
  if (value.startsWith('/') || /^[A-Za-z]:\//u.test(value)) return false;
  return !value.split('/').includes('..');
}

function safeVerificationExecutable(argv: readonly string[]): boolean {
  const executable = argv[0];
  const verb = argv[1];
  if (executable === undefined) return false;
  if (directVerificationExecutables.has(executable)) return true;
  if (executable === 'python' || executable === 'python3') {
    return verb === '-m' && argv[2] !== undefined && pythonVerificationModules.has(argv[2]);
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

export const verificationCommandSchema = z
  .object({
    tier: z.enum(['focused', 'package', 'full']),
    cwd: rootPathSchema,
    argv: z.array(safeText(256)).min(1).max(32),
    basis: safeText(256),
  })
  .strict()
  .superRefine((command, context) => {
    if (
      !safeVerificationExecutable(command.argv) ||
      command.argv.some((arg) => !safeVerificationArg(arg))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['argv'],
        message: 'verification command argv is not conservative',
      });
    }
  });

export const contextCoverageSchema = z
  .object({
    status: z.enum(['complete', 'partial', 'unavailable']),
    reasonCodes: z.array(reasonCodeSchema).max(32),
    observed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((coverage, context) => {
    if (coverage.total !== undefined && coverage.total < coverage.observed) {
      context.addIssue({
        code: 'custom',
        path: ['total'],
        message: 'coverage total cannot be less than observed',
      });
    }
  });

/**
 * Normalize and deduplicate the privacy-bound task file set.
 *
 * @throws {RangeError} When the caller supplies more than the bounded file limit.
 * @throws {TypeError} When a file is not a safe project-relative path.
 */
function normalizedTaskContextFiles(files: readonly string[]): readonly string[] {
  if (files.length > MAX_TASK_CONTEXT_FILES) {
    throw new RangeError(`task-context file scope accepts at most ${MAX_TASK_CONTEXT_FILES} files`);
  }
  const normalized = files.map((file) => file.replaceAll('\\', '/'));
  if (
    normalized.some((file) => !relativePathSchema.safeParse(file).success || /\p{Cc}/u.test(file))
  ) {
    throw new TypeError('task-context file scope requires normalized project-relative paths');
  }
  return [...new Set(normalized)].sort(compareCodePoints);
}

export function buildTaskContextFileScope(files: readonly string[] = []): TaskContextFileScope {
  const normalized = normalizedTaskContextFiles(files);
  const mode = normalized.length === 0 ? 'project' : 'explicit';
  const filesIdentity = `sha256:${createHash('sha256')
    .update(JSON.stringify({ schemaVersion: 1, mode, files: normalized }), 'utf8')
    .digest('hex')}`;
  return { mode, fileCount: normalized.length, filesIdentity };
}

export function buildTaskContextProjectIdentity(canonicalProjectRoot: string): string {
  if (
    canonicalProjectRoot.length === 0 ||
    canonicalProjectRoot.length > 4096 ||
    /\p{Cc}/u.test(canonicalProjectRoot)
  ) {
    throw new TypeError('task-context project root must be a bounded canonical path');
  }
  return `sha256:${createHash('sha256')
    .update('opensip-task-context-project-v1\0', 'utf8')
    .update(canonicalProjectRoot, 'utf8')
    .digest('hex')}`;
}
