import { isAbsolute } from 'node:path';

import { AST, GLOBSTAR, Minimatch } from 'minimatch';

import { MAX_BOUNDED_BRACE_EXPANSIONS } from './bounded-resolve-inputs.js';
import { compareCodePointStrings } from './code-point-order.js';

import type { TargetView } from '@opensip-cli/core';
import type { MinimatchOptions } from 'minimatch';

const PLATFORM_NOCASE = process.platform === 'darwin' || process.platform === 'win32';

// These options pin glob 13's effective host-platform semantics. Include and
// ignore matching are case-insensitive on Darwin/Windows, comments/negation
// are literal, and includes do not cross undeclared dot path segments.
const INCLUDE_MATCH_OPTIONS: Readonly<MinimatchOptions> = Object.freeze({
  braceExpandMax: MAX_BOUNDED_BRACE_EXPANSIONS,
  dot: false,
  nocase: PLATFORM_NOCASE,
  nocaseMagicOnly: false,
  nocomment: true,
  nonegate: true,
  optimizationLevel: 2,
  platform: process.platform,
  windowsPathsNoEscape: false,
});

const IGNORE_MATCH_OPTIONS: Readonly<MinimatchOptions> = Object.freeze({
  ...INCLUDE_MATCH_OPTIONS,
  dot: true,
});

// Existing target/global post-filters use raw Minimatch defaults plus dot:true:
// case-sensitive, comment/negation-aware, optimization level 1.
const POST_FILTER_MATCH_OPTIONS: Readonly<MinimatchOptions> = Object.freeze({
  braceExpandMax: MAX_BOUNDED_BRACE_EXPANSIONS,
  dot: true,
  nocase: false,
  nocaseMagicOnly: false,
  nocomment: false,
  nonegate: false,
  optimizationLevel: 1,
  platform: process.platform,
  windowsPathsNoEscape: false,
});

interface CompiledGlobPattern {
  readonly absolute: boolean;
  readonly fileSlashMode: 'globstar-tail' | 'always';
  readonly matcher: Minimatch;
  readonly staticTerminalGlobstarAlternatives: readonly boolean[];
}

export interface CompiledTarget {
  readonly includes: readonly CompiledGlobPattern[];
  readonly ignoreExcludes: readonly CompiledGlobPattern[];
  readonly name: string;
  readonly postFilterExcludes: readonly Minimatch[];
}

function stripLeadingDotSegments(pattern: string): string {
  let normalized = pattern;
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}

function compileGlobPattern(
  pattern: string,
  options: Readonly<MinimatchOptions>,
  fileSlashMode: CompiledGlobPattern['fileSlashMode'],
): CompiledGlobPattern {
  const absolute = isAbsolute(pattern);
  const matcher = new Minimatch(absolute ? pattern : stripLeadingDotSegments(pattern), options);
  return {
    absolute,
    fileSlashMode,
    matcher,
    staticTerminalGlobstarAlternatives: Object.freeze(
      matcher.set.map((patternParts, index) => {
        const globParts = matcher.globParts[index];
        return (
          patternParts.at(-1) === GLOBSTAR &&
          globParts?.slice(0, -1).every(
            // Glob 13 consumes only statically resolvable prefix segments before
            // mounting a terminal globstar on that exact path. On nocase hosts
            // Minimatch represents literals as regexps for enumeration, so parse
            // each already-expanded segment without nocase to recover that shape.
            (part) =>
              typeof AST.fromGlob(part, {
                ...options,
                nocase: false,
                nocaseMagicOnly: true,
              }).toMMPattern() === 'string',
          ) === true
        );
      }),
    ),
  };
}

export function compileTargets(targets: readonly TargetView[]): readonly CompiledTarget[] {
  return targets
    .map((target) => ({
      includes: target.config.include.map((pattern) =>
        compileGlobPattern(pattern, INCLUDE_MATCH_OPTIONS, 'globstar-tail'),
      ),
      ignoreExcludes: target.config.exclude.map((pattern) =>
        compileGlobPattern(pattern, IGNORE_MATCH_OPTIONS, 'always'),
      ),
      name: target.config.name,
      postFilterExcludes: target.config.exclude.map(
        (pattern) => new Minimatch(pattern, POST_FILTER_MATCH_OPTIONS),
      ),
    }))
    .sort((left, right) => compareCodePointStrings(left.name, right.name));
}

export function compileGlobalExcludes(patterns: readonly string[]): readonly Minimatch[] {
  return patterns.map((pattern) => new Minimatch(pattern, POST_FILTER_MATCH_OPTIONS));
}

function slashSplit(matcher: Minimatch, candidate: string): string[] {
  if (matcher.preserveMultipleSlashes) return candidate.split('/');
  if (matcher.isWindows && /^\/\/[^/]+/u.test(candidate)) {
    return ['', ...candidate.split(/\/+/u)];
  }
  return candidate.split(/\/+/u);
}

function matchesGlobstarTailFileCandidate(
  pattern: CompiledGlobPattern,
  candidate: string,
): boolean {
  const fileParts = slashSplit(pattern.matcher, `${candidate}/`);
  return pattern.matcher.set.some(
    (patternParts, index) =>
      pattern.staticTerminalGlobstarAlternatives[index] === true &&
      pattern.matcher.matchOne(fileParts, patternParts, false),
  );
}

function matchesGlobPattern(
  pattern: CompiledGlobPattern,
  relativePath: string,
  absolutePath: string,
): boolean {
  const candidate = pattern.absolute ? absolutePath.replaceAll('\\', '/') : relativePath;
  if (pattern.matcher.match(candidate)) return true;
  if (pattern.fileSlashMode === 'always') return pattern.matcher.match(`${candidate}/`);
  // glob 13 treats a regular file as a match for a pattern alternative whose
  // final parsed segment is GLOBSTAR by testing the path with a trailing slash.
  // Restrict the test to that exact set alternative: testing the whole matcher
  // would let a sibling brace alternative such as `foo.ts/` match a file.
  return matchesGlobstarTailFileCandidate(pattern, candidate);
}

export function targetRetainsFile(
  target: CompiledTarget,
  relativePath: string,
  absolutePath: string,
): boolean {
  return (
    target.includes.some((pattern) => matchesGlobPattern(pattern, relativePath, absolutePath)) &&
    !target.ignoreExcludes.some((pattern) =>
      matchesGlobPattern(pattern, relativePath, absolutePath),
    ) &&
    !target.postFilterExcludes.some((pattern) => pattern.match(relativePath))
  );
}

export function matchingTargetNames(
  targets: readonly CompiledTarget[],
  relativePath: string,
  absolutePath: string,
): readonly string[] {
  const names: string[] = [];
  for (const target of targets) {
    if (targetRetainsFile(target, relativePath, absolutePath) && names.at(-1) !== target.name) {
      names.push(target.name);
    }
  }
  return names;
}
