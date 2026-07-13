import { lstatSync } from 'node:fs';

import { makeStepRecord } from '../model/record.js';
import { safeErrorDetail } from '../runner/error-detail.js';
import { resolveInsideRoot } from '../runner/workspace-paths.js';

import {
  globToRegex,
  readPrefix,
  renderBounded,
  TRUNCATION_MARKER,
  walkFiles,
} from './native-files.js';

import type { WalkResult } from './native-files.js';
import type { ToolInvoker } from '../model/record.js';
import type { JsonObject, ResolvedStrategyStep, RunLeg } from '../model/task.js';

const DEFAULT_MAX_MATCHES = 200;
const DEFAULT_MAX_READ_BYTES = 256 * 1024;
const DEFAULT_MAX_WALKED_FILES = 20_000;
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_GLOB_RESULTS = 2000;

const HARD_MAX_MATCHES = 2000;
const HARD_MAX_READ_BYTES = 1024 * 1024;
const HARD_MAX_WALKED_FILES = 50_000;
const HARD_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const HARD_MAX_FILE_BYTES = 2 * 1024 * 1024;
const HARD_MAX_GLOB_RESULTS = 2000;
const HARD_MAX_CONTEXT_LINES = 40;
const MIN_RENDER_BUDGET_BYTES = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');

type NativeToolName = 'contentSearch' | 'globList' | 'readFile';

/** One deterministic, project-relative content-search match. */
export interface NativeMatch {
  readonly context?: string;
  readonly contextStartLine?: number;
  readonly line: number;
  readonly path: string;
  readonly text: string;
}

/** Structured payload returned by the bounded native content search. */
export interface NativeContentSearchPayload {
  readonly matches: readonly NativeMatch[];
  readonly pattern: string;
  readonly truncated: boolean;
}

/** Structured payload returned by the bounded native glob inventory. */
export interface NativeGlobPayload {
  readonly paths: readonly string[];
  readonly truncated: boolean;
}

/** Structured payload returned by a bounded native file read. */
export interface NativeReadPayload {
  readonly content: string;
  readonly path: string;
  readonly truncated: boolean;
}

interface NativeInvocationResult {
  readonly payload: NativeContentSearchPayload | NativeGlobPayload | NativeReadPayload;
  readonly rendered: string;
  readonly truncated: boolean;
}

/** Optional prevalidated file view used by clean dogfood evaluation. */
export interface NativeInvokerOptions {
  readonly allowedPaths?: readonly string[];
}

function boundedInteger(value: unknown, defaultValue: number, hardMaximum: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, hardMaximum)
    : defaultValue;
}

function boundedContextLines(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, HARD_MAX_CONTEXT_LINES)
    : 0;
}

/**
 * Resolve a render budget large enough to disclose truncation honestly.
 *
 * @throws {RangeError} When the requested budget cannot contain the truncation marker.
 */
function boundedRenderBudget(value: unknown): number {
  const budget = boundedInteger(value, DEFAULT_MAX_TOTAL_BYTES, HARD_MAX_TOTAL_BYTES);
  if (budget < MIN_RENDER_BUDGET_BYTES) {
    throw new RangeError(
      `Native contentSearch maxTotalBytes must be at least ${String(MIN_RENDER_BUDGET_BYTES)}.`,
    );
  }
  return budget;
}

/**
 * Read one required, bounded string argument from a native invocation.
 *
 * @throws {TypeError} When the argument is missing, empty, non-string, or oversized.
 */
function stringArgument(args: JsonObject, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new TypeError(
      `Native tool argument ${name} must be a non-empty string of at most 4096 characters.`,
    );
  }
  return value;
}

interface ContentSearchOptions {
  readonly contextLines: number;
  readonly glob?: RegExp;
  readonly matcher: RegExp;
  readonly maxFileBytes: number;
  readonly maxMatches: number;
  readonly maxTotalBytes: number;
  readonly walked: WalkResult;
}

interface ContentSearchState {
  matchBytes: number;
  readonly matches: NativeMatch[];
  stopped: boolean;
  truncated: boolean;
}

interface CandidateMatch {
  readonly context?: string;
  readonly contextStartLine?: number;
  readonly line: number;
  readonly path: string;
  readonly text: string;
}

function retainMatch(
  match: CandidateMatch,
  options: ContentSearchOptions,
  state: ContentSearchState,
): boolean {
  if (state.matches.length >= options.maxMatches) {
    state.truncated = true;
    state.stopped = true;
    return false;
  }
  const renderedBytes = Buffer.byteLength(
    `${match.path}:${String(match.line)}:${match.context ?? match.text}`,
    'utf8',
  );
  if (state.matchBytes + renderedBytes + 1 > options.maxTotalBytes) {
    state.truncated = true;
    state.stopped = true;
    return false;
  }
  state.matches.push({
    ...(match.context === undefined ? {} : { context: match.context }),
    ...(match.contextStartLine === undefined ? {} : { contextStartLine: match.contextStartLine }),
    line: match.line,
    path: match.path,
    text: match.text,
  });
  state.matchBytes += renderedBytes + 1;
  return true;
}

function searchFileLines(
  path: string,
  content: Buffer,
  options: ContentSearchOptions,
  state: ContentSearchState,
): void {
  const lines = content.toString('utf8').split(/\r?\n/u);
  for (const [index, lineText] of lines.entries()) {
    options.matcher.lastIndex = 0;
    if (!options.matcher.test(lineText)) continue;
    const contextStart = Math.max(0, index - options.contextLines);
    const contextEnd = Math.min(lines.length, index + options.contextLines + 1);
    const context =
      options.contextLines === 0 ? undefined : lines.slice(contextStart, contextEnd).join('\n');
    if (
      !retainMatch(
        {
          ...(context === undefined ? {} : { context, contextStartLine: contextStart + 1 }),
          line: index + 1,
          path,
          text: lineText,
        },
        options,
        state,
      )
    )
      return;
  }
}

function searchFile(
  workspaceRoot: string,
  path: string,
  options: ContentSearchOptions,
  state: ContentSearchState,
): void {
  if (options.glob && !options.glob.test(path)) return;
  const absolute = resolveInsideRoot(workspaceRoot, path);
  if (!lstatSync(absolute).isFile()) return;
  const content = readPrefix(absolute, options.maxFileBytes);
  if (content.truncated) state.truncated = true;
  searchFileLines(path, content.buffer, options, state);
}

function collectContentMatches(
  workspaceRoot: string,
  options: ContentSearchOptions,
): { readonly matches: readonly NativeMatch[]; readonly truncated: boolean } {
  const state: ContentSearchState = {
    matchBytes: 0,
    matches: [],
    stopped: false,
    truncated: options.walked.truncated,
  };
  for (const path of options.walked.paths) {
    searchFile(workspaceRoot, path, options, state);
    if (state.stopped) break;
  }
  return { matches: state.matches, truncated: state.truncated };
}

function walkedFiles(
  workspaceRoot: string,
  maxFiles: number,
  allowedPaths: readonly string[] | undefined,
): WalkResult {
  if (allowedPaths === undefined) return walkFiles(workspaceRoot, maxFiles);
  return {
    paths: allowedPaths.slice(0, maxFiles),
    truncated: allowedPaths.length > maxFiles,
  };
}

function contentSearch(
  workspaceRoot: string,
  args: JsonObject,
  allowedPaths: readonly string[] | undefined,
): NativeInvocationResult {
  const maxTotalBytes = boundedRenderBudget(args.maxTotalBytes);
  const pattern = stringArgument(args, 'pattern');
  const collected = collectContentMatches(workspaceRoot, {
    contextLines: boundedContextLines(args.contextLines),
    ...(typeof args.glob === 'string' ? { glob: globToRegex(args.glob) } : {}),
    matcher: new RegExp(pattern, 'u'),
    maxFileBytes: boundedInteger(args.maxFileBytes, DEFAULT_MAX_FILE_BYTES, HARD_MAX_FILE_BYTES),
    maxMatches: boundedInteger(args.maxMatches, DEFAULT_MAX_MATCHES, HARD_MAX_MATCHES),
    maxTotalBytes,
    walked: walkedFiles(
      workspaceRoot,
      boundedInteger(args.maxWalkedFiles, DEFAULT_MAX_WALKED_FILES, HARD_MAX_WALKED_FILES),
      allowedPaths,
    ),
  });
  const bounded = renderBounded(
    collected.matches.map(
      (match) => `${match.path}:${String(match.line)}:${match.context ?? match.text}`,
    ),
    maxTotalBytes,
    collected.truncated,
  );
  return {
    payload: {
      matches: collected.matches.slice(0, bounded.retainedCount),
      pattern,
      truncated: bounded.truncated,
    },
    rendered: bounded.rendered,
    truncated: bounded.truncated,
  };
}

/**
 * Read one admitted, bounded workspace file.
 *
 * @throws {Error} When the path is not in the optional Git-visible file view or cannot be read.
 */
function readFileTool(
  workspaceRoot: string,
  args: JsonObject,
  allowedPaths: readonly string[] | undefined,
): NativeInvocationResult {
  const path = stringArgument(args, 'path');
  if (allowedPaths !== undefined && !allowedPaths.includes(path)) {
    throw new Error('Native readFile path is outside the admitted Git-visible file view.');
  }
  const maxBytes = boundedInteger(args.maxBytes, DEFAULT_MAX_READ_BYTES, HARD_MAX_READ_BYTES);
  const absolute = resolveInsideRoot(workspaceRoot, path);
  const result = readPrefix(absolute, maxBytes);
  const content = result.buffer.toString('utf8');
  const rendered = result.truncated ? `${content}\n${TRUNCATION_MARKER}` : content;
  return {
    payload: { content, path, truncated: result.truncated },
    rendered,
    truncated: result.truncated,
  };
}

function globList(
  workspaceRoot: string,
  args: JsonObject,
  allowedPaths: readonly string[] | undefined,
): NativeInvocationResult {
  const pattern = globToRegex(stringArgument(args, 'pattern'));
  const maxWalkedFiles = boundedInteger(
    args.maxWalkedFiles,
    DEFAULT_MAX_WALKED_FILES,
    HARD_MAX_WALKED_FILES,
  );
  const maxResults = boundedInteger(
    args.maxResults,
    DEFAULT_MAX_GLOB_RESULTS,
    HARD_MAX_GLOB_RESULTS,
  );
  const walked = walkedFiles(workspaceRoot, maxWalkedFiles, allowedPaths);
  const allMatches = walked.paths.filter((path) => pattern.test(path));
  const paths = allMatches.slice(0, maxResults);
  const truncated = walked.truncated || allMatches.length > maxResults;
  const bounded = renderBounded(paths, DEFAULT_MAX_TOTAL_BYTES, truncated);
  return {
    payload: {
      paths: paths.slice(0, bounded.retainedCount),
      truncated: bounded.truncated,
    },
    rendered: bounded.rendered,
    truncated: bounded.truncated,
  };
}

/**
 * Narrow a tool name to the closed native-tool vocabulary.
 *
 * @throws {TypeError} When the requested tool is not supported by the native arm.
 */
function nativeToolName(value: string): NativeToolName {
  if (value === 'contentSearch' || value === 'globList' || value === 'readFile') return value;
  throw new TypeError(`Unsupported native tool: ${value}`);
}

function runNativeTool(
  workspaceRoot: string,
  step: ResolvedStrategyStep,
  options: NativeInvokerOptions,
): NativeInvocationResult {
  const tool = nativeToolName(step.tool);
  switch (tool) {
    case 'contentSearch': {
      return contentSearch(workspaceRoot, step.arguments, options.allowedPaths);
    }
    case 'globList': {
      return globList(workspaceRoot, step.arguments, options.allowedPaths);
    }
    case 'readFile': {
      return readFileTool(workspaceRoot, step.arguments, options.allowedPaths);
    }
    default: {
      const exhaustive: never = tool;
      return exhaustive;
    }
  }
}

function stepLeg(step: ResolvedStrategyStep): RunLeg {
  return step.leg ?? 'main';
}

function invokeNativeStep(
  workspaceRoot: string,
  step: ResolvedStrategyStep,
  options: NativeInvokerOptions,
) {
  const startedAt = performance.now();
  try {
    const result = runNativeTool(workspaceRoot, step, options);
    const facts = step.extract(result.payload);
    const proofClosure = step.assessProofClosure?.(result.payload);
    return makeStepRecord({
      completeness: result.truncated ? 'incomplete' : 'complete',
      facts,
      leg: stepLeg(step),
      proofClosure,
      renderedResponse: result.rendered,
      step,
      truncated: result.truncated,
      wallMs: Math.max(0, performance.now() - startedAt),
    });
  } catch (error) {
    return makeStepRecord({
      failure: {
        code: 'native-tool-failure',
        kind: 'tool',
        message: safeErrorDetail(error, [workspaceRoot]),
      },
      leg: stepLeg(step),
      renderedResponse: '',
      step,
      wallMs: Math.max(0, performance.now() - startedAt),
    });
  }
}

/** Bind deterministic native search/read/glob tools to one rooted workspace. */
export function createNativeInvoker(
  workspaceRoot: string,
  options: NativeInvokerOptions = {},
): ToolInvoker {
  return (step) => Promise.resolve(invokeNativeStep(workspaceRoot, step, options));
}
