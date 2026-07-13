import {
  escapeRegularExpression,
  isUnknownRecord as isRecord,
  uniqueFacts,
} from '../model/value-helpers.js';

import {
  projectLexicalEnclosingFunction,
  type NativeMatchProjection,
} from './native-lexical-enclosure.js';
import { nativeSearchMatches } from './native-response.js';

import type { NativeSearchMatch } from './native-response.js';
import type {
  AnswerFact,
  ProofClosureAssessment,
  ProofClosureAssessor,
  ResponseExtractor,
} from '../model/task.js';

/** Match the deliberately small test-glob vocabulary used by gold fixtures. */
export function pathMatchesSupportedTestGlob(path: string, glob: string): boolean {
  switch (glob) {
    case '**/*.test.ts': {
      return path.endsWith('.test.ts');
    }
    case '**/*.spec.ts': {
      return path.endsWith('.spec.ts');
    }
    case 'tests/test_*.py': {
      return path.startsWith('tests/test_') && path.endsWith('.py');
    }
    default: {
      return false;
    }
  }
}

function isImportOrExport(line: string): boolean {
  return /^\s*(?:export\s+\{|from\s+|import\s+)/u.test(line);
}

function projectNonTestMatch(
  match: NativeSearchMatch,
  searchedPattern: RegExp,
): NativeMatchProjection {
  if (
    match.context === undefined ||
    match.contextStartLine === undefined ||
    match.line === undefined ||
    isImportOrExport(match.text)
  ) {
    return { kind: 'unresolved' };
  }
  const lines = match.context.split(/\r?\n/u);
  const matchIndex = match.line - match.contextStartLine;
  if (matchIndex < 0 || matchIndex >= lines.length) return { kind: 'unresolved' };
  return projectLexicalEnclosingFunction({
    contextStartLine: match.contextStartLine,
    lines,
    matchIndex,
    path: match.path,
    searchedPattern,
  });
}

function callerPattern(names: readonly string[]): string | undefined {
  const unique = [...new Set(names)].sort();
  if (unique.length === 0) return undefined;
  return `(?:${unique.map(escapeRegularExpression).join('|')})`;
}

interface FrontierAnalysis {
  readonly facts: readonly AnswerFact[];
  readonly proofClosure: ProofClosureAssessment;
}

function frontierAnalysis(payload: unknown, testGlobs: readonly string[]): FrontierAnalysis {
  const matches = nativeSearchMatches(payload);
  if (!isRecord(payload) || typeof payload.pattern !== 'string' || matches === undefined) {
    return {
      facts: [],
      proofClosure: {
        domainExhausted: false,
        projectionComplete: false,
        reasonCodes: ['malformed-native-frontier'],
      },
    };
  }
  const searchedPattern = new RegExp(payload.pattern, 'u');
  const testFacts: AnswerFact[] = [];
  const callerNames: string[] = [];
  let unresolved = 0;
  for (const match of matches) {
    if (testGlobs.some((glob) => pathMatchesSupportedTestGlob(match.path, glob))) {
      testFacts.push({ kind: 'file', path: match.path, role: 'test' });
      continue;
    }
    const projection = projectNonTestMatch(match, searchedPattern);
    if (projection.kind === 'caller') callerNames.push(projection.name);
    if (projection.kind === 'unresolved') unresolved += 1;
  }
  const pattern = callerPattern(callerNames);
  const projectionComplete = unresolved === 0;
  return {
    facts: uniqueFacts([
      ...testFacts,
      ...(pattern === undefined
        ? []
        : [
            {
              kind: 'text',
              label: 'caller-frontier-pattern',
              value: pattern,
            } as const,
          ]),
    ]),
    proofClosure: {
      domainExhausted: projectionComplete && pattern === undefined,
      projectionComplete,
      reasonCodes: [
        ...(projectionComplete ? [] : ['unresolved-native-reference']),
        ...(pattern === undefined ? [] : ['caller-frontier-open']),
      ],
    },
  };
}

/** Loss-aware native test/caller projection shared by extraction and proof scoring. */
export function createTestAndCallerFrontierProjection(testGlobs: readonly string[]): {
  readonly assessProofClosure: ProofClosureAssessor;
  readonly extract: ResponseExtractor;
} {
  return {
    assessProofClosure: (payload) => frontierAnalysis(payload, testGlobs).proofClosure,
    extract: (payload) => frontierAnalysis(payload, testGlobs).facts,
  };
}
