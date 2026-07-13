import {
  escapeRegularExpression,
  isUnknownRecord as isRecord,
  parseJsonRecord,
  uniqueFacts,
} from '../model/value-helpers.js';

import { asNativeReadPayload, nativeSearchMatches } from './native-response.js';

import type { AnswerFact } from '../model/task.js';
import type { UnknownRecord } from '../model/value-helpers.js';

function records(value: unknown): readonly UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export interface JsonManifestProjection {
  readonly manifest: UnknownRecord;
  readonly path: string;
}

function hasProjectableScriptFields(manifest: UnknownRecord): boolean {
  const scripts = manifest.scripts;
  if (scripts === undefined) return true;
  if (!isRecord(scripts)) return false;
  return ['build', 'test'].every(
    (field) => scripts[field] === undefined || typeof scripts[field] === 'string',
  );
}

/** Parse and validate every manifest field projected into command/package facts. */
export function projectJsonManifest(payload: unknown): JsonManifestProjection | undefined {
  const result = asNativeReadPayload(payload);
  if (!result?.path.endsWith('.json')) return undefined;
  const manifest = parseJsonRecord(result.content);
  if (
    manifest === undefined ||
    (manifest.name !== undefined && typeof manifest.name !== 'string') ||
    (manifest.packageManager !== undefined && typeof manifest.packageManager !== 'string') ||
    !hasProjectableScriptFields(manifest)
  ) {
    return undefined;
  }
  return { manifest, path: result.path };
}

function extractMatchFiles(payload: unknown, role: string): readonly AnswerFact[] {
  if (!isRecord(payload)) return [];
  return uniqueFacts(
    records(payload.matches).flatMap((match): readonly AnswerFact[] => {
      const path = optionalString(match.path);
      return path === undefined ? [] : [{ kind: 'file', path, role }];
    }),
  );
}

export function extractNativeCallerCandidates(payload: unknown): readonly AnswerFact[] {
  return extractMatchFiles(payload, 'caller-candidate');
}

/** Retain broad textual references and distinguish registry-value sites. */
export function extractTargetReferenceFiles(target: string) {
  const registryValue = new RegExp(`:\\s*${escapeRegularExpression(target)}\\b`, 'u');
  return (payload: unknown): readonly AnswerFact[] => {
    const matches = nativeSearchMatches(payload);
    if (matches === undefined) return [];
    return uniqueFacts(
      matches.flatMap(({ path, text }): readonly AnswerFact[] => [
        { kind: 'file', path, role: 'target-reference' },
        ...(registryValue.test(text)
          ? ([{ kind: 'file', path, role: 'dynamic-reference' }] as const)
          : []),
      ]),
    );
  };
}

/** Discover named TypeScript/JavaScript or Python functions from a native file read. */
export function extractDeclaredFunctionSymbols(payload: unknown): readonly AnswerFact[] {
  const result = asNativeReadPayload(payload);
  if (result === undefined) return [];
  const expressions = [
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gu,
    /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gmu,
  ];
  return uniqueFacts(
    expressions.flatMap((expression) =>
      [...result.content.matchAll(expression)].flatMap((match): readonly AnswerFact[] => {
        const name = match[1];
        return name === undefined ? [] : [{ filePath: result.path, kind: 'symbol', name }];
      }),
    ),
  );
}

export function extractPackageManifestPaths(payload: unknown): readonly AnswerFact[] {
  if (!isRecord(payload) || !Array.isArray(payload.paths)) return [];
  return uniqueFacts(
    payload.paths.flatMap((path): readonly AnswerFact[] =>
      typeof path === 'string' ? [{ kind: 'file', path, role: 'package-manifest' }] : [],
    ),
  );
}

export function extractAliasSourcePaths(payload: unknown): readonly AnswerFact[] {
  if (!isRecord(payload)) return [];
  return uniqueFacts(
    records(payload.matches).flatMap((match): readonly AnswerFact[] => {
      const path = optionalString(match.path);
      return path ? [{ kind: 'file', path, role: 'alias-source' }] : [];
    }),
  );
}

export function extractCallableAliasesFromSource(target: string) {
  const escaped = escapeRegularExpression(target);
  const exportAlias = new RegExp(`\\b${escaped}\\s+as\\s+([A-Za-z_$][\\w$]*)`, 'gu');
  const wrapper = new RegExp(
    `\\bfunction\\s+([A-Za-z_$][\\w$]*)\\s*\\([^)]*\\)[^{]*\\{[^}]*\\b${escaped}\\s*\\(`,
    'gu',
  );
  return (payload: unknown): readonly AnswerFact[] => {
    if (!isRecord(payload) || typeof payload.content !== 'string') return [];
    const aliases = [
      ...payload.content.matchAll(exportAlias),
      ...payload.content.matchAll(wrapper),
    ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
    return [...new Set(aliases)].map((value) => ({
      kind: 'text',
      label: 'call-alias',
      value,
    }));
  };
}

export function extractPackageNamesFromManifestMatches(payload: unknown): readonly AnswerFact[] {
  if (!isRecord(payload)) return [];
  return uniqueFacts(
    records(payload.matches).flatMap((match): readonly AnswerFact[] => {
      const text = optionalString(match.text);
      const name = text && /["']name["']\s*:\s*["']([^"']+)["']/u.exec(text)?.[1];
      return name ? [{ kind: 'package', name }] : [];
    }),
  );
}

export function extractPackageManifestFacts(payload: unknown): readonly AnswerFact[] {
  if (!isRecord(payload)) return [];
  const content = optionalString(payload.content);
  const path = optionalString(payload.path);
  if (content === undefined || path === undefined) return [];
  const projection = path.endsWith('.json') ? projectJsonManifest(payload) : undefined;
  if (path.endsWith('.json') && projection === undefined) return [];
  const name = projection
    ? optionalString(projection.manifest.name)
    : /^name\s*=\s*["']([^"']+)["']\s*$/mu.exec(content)?.[1];
  return name ? [{ kind: 'package', name }] : [];
}

function packageManagerCommand(manifest: UnknownRecord): string | undefined {
  const packageManager = optionalString(manifest.packageManager)?.split('@')[0];
  if (!isRecord(manifest.scripts) || optionalString(manifest.scripts.test) === undefined) {
    return undefined;
  }
  switch (packageManager) {
    case 'bun':
    case 'npm':
    case 'pnpm': {
      return `${packageManager} test`;
    }
    case 'yarn': {
      return 'yarn test';
    }
    default: {
      return undefined;
    }
  }
}

export function extractFallbackFromManifest(payload: unknown): readonly AnswerFact[] {
  if (!isRecord(payload)) return [];
  const content = optionalString(payload.content);
  const path = optionalString(payload.path);
  if (content === undefined || path === undefined) return [];
  if (!path.endsWith('.json')) {
    return /^\[tool\.pytest\.ini_options\]\s*$/mu.test(content)
      ? [{ command: 'pytest', kind: 'command', purpose: 'fallback' }]
      : [];
  }
  const projection = projectJsonManifest(payload);
  if (projection === undefined) return [];
  const fallback = packageManagerCommand(projection.manifest);
  const implementation = isRecord(projection.manifest.scripts)
    ? optionalString(projection.manifest.scripts.test)
    : undefined;
  return [
    ...(fallback ? ([{ command: fallback, kind: 'command', purpose: 'fallback' }] as const) : []),
    ...(implementation
      ? ([{ command: implementation, kind: 'command', purpose: 'test-script' }] as const)
      : []),
  ];
}
