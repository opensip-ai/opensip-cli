import { isUnknownRecord as isRecord, uniqueFacts } from '../model/value-helpers.js';

export {
  extractAliasSourcePaths,
  extractCallableAliasesFromSource,
  extractDeclaredFunctionSymbols,
  extractFallbackFromManifest,
  extractNativeCallerCandidates,
  extractPackageManifestFacts,
  extractPackageManifestPaths,
  extractPackageNamesFromManifestMatches,
  extractTargetReferenceFiles,
} from './native-task-response-extractors.js';

import type { AnswerFact, SymbolHandleFact } from '../model/task.js';
import type { UnknownRecord } from '../model/value-helpers.js';

/** Read the conventional MCP response `data` object after validating its shape. */
export function responseDataRecord(payload: unknown): UnknownRecord | undefined {
  if (!isRecord(payload) || !isRecord(payload.data)) return undefined;
  return payload.data;
}

function records(value: unknown): readonly UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function symbolHandle(symbol: UnknownRecord): SymbolHandleFact | undefined {
  const symbolId = optionalString(symbol.symbolId);
  if (symbolId === undefined) return undefined;
  const bodyHash = optionalString(symbol.bodyHash);
  const column = optionalNumber(symbol.column);
  const filePath = optionalString(symbol.filePath);
  const line = optionalNumber(symbol.line);
  const name = optionalString(symbol.simpleName);
  const packageName = optionalString(symbol.package);
  const qualifiedName = optionalString(symbol.qualifiedName);
  return {
    kind: 'symbol-handle',
    symbolId,
    ...(bodyHash === undefined ? {} : { bodyHash }),
    ...(column === undefined ? {} : { column }),
    ...(filePath === undefined ? {} : { filePath }),
    ...(typeof symbol.inTestFile === 'boolean' ? { inTestFile: symbol.inTestFile } : {}),
    ...(line === undefined ? {} : { line }),
    ...(name === undefined ? {} : { name }),
    ...(packageName === undefined ? {} : { package: packageName }),
    ...(qualifiedName === undefined ? {} : { qualifiedName }),
  };
}

function factsForSymbol(symbol: UnknownRecord): readonly AnswerFact[] {
  const handle = symbolHandle(symbol);
  if (handle === undefined) return [];
  const facts: AnswerFact[] = [handle];
  if (handle.name) {
    facts.push({
      kind: 'symbol',
      name: handle.name,
      ...(handle.filePath ? { filePath: handle.filePath } : {}),
      ...(handle.line === undefined ? {} : { line: handle.line }),
      ...(handle.package ? { package: handle.package } : {}),
    });
  }
  if (handle.filePath) {
    facts.push({
      kind: 'file',
      path: handle.filePath,
      role: 'symbol-definition',
    });
  }
  if (handle.package) facts.push({ kind: 'package', name: handle.package });
  return facts;
}

export function extractSymbolSearch(payload: unknown): readonly AnswerFact[] {
  if (!isRecord(payload) || !isRecord(payload.data)) return [];
  return uniqueFacts(records(payload.data.symbols).flatMap(factsForSymbol));
}

export function callerEvidenceSubject(filePath: string, name: string): string {
  return `${filePath}#${name}`;
}

function evidenceForCaller(
  symbol: SymbolHandleFact,
  incomingEvidence: unknown,
): readonly AnswerFact[] {
  if (!isRecord(incomingEvidence) || !symbol.filePath || !symbol.name) return [];
  const confidence = optionalString(incomingEvidence.confidence);
  const evidenceKind = optionalString(incomingEvidence.kind);
  const resolution = optionalString(incomingEvidence.resolution);
  return [
    {
      kind: 'evidence',
      subject: callerEvidenceSubject(symbol.filePath, symbol.name),
      filePath: symbol.filePath,
      ...(confidence ? { confidence } : {}),
      ...(evidenceKind ? { evidenceKind } : {}),
      ...(resolution ? { resolution } : {}),
    },
  ];
}

function callerNodeFacts(node: UnknownRecord): readonly AnswerFact[] {
  if (typeof node.depth !== 'number' || node.depth <= 0 || !isRecord(node.symbol)) return [];
  const handle = symbolHandle(node.symbol);
  if (!handle?.filePath) return [];
  return [
    {
      kind: 'file',
      path: handle.filePath,
      role: 'caller',
    },
    ...factsForSymbol(node.symbol),
    ...evidenceForCaller(handle, node.incomingEvidence),
  ];
}

const MAX_UNRESOLVED_TARGET_HASHES = 20;
const MAX_TARGET_HASH_LENGTH = 128;

function targetBodyHashes(nodes: unknown): ReadonlySet<string> {
  const hashes = records(nodes).flatMap((node) => {
    if (node.depth !== 0 || !isRecord(node.symbol)) return [];
    const hash = optionalString(node.symbol.bodyHash);
    return hash === undefined ? [] : [hash];
  });
  return new Set(hashes);
}

function boundedTargetHashes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (candidate): candidate is string =>
        typeof candidate === 'string' &&
        candidate.length > 0 &&
        candidate.length <= MAX_TARGET_HASH_LENGTH,
    )
    .slice(0, MAX_UNRESOLVED_TARGET_HASHES);
}

function unresolvedCallerFacts(
  value: unknown,
  targetHashes: ReadonlySet<string>,
  attribution: unknown,
): readonly AnswerFact[] {
  return records(value).flatMap((row): readonly AnswerFact[] => {
    if (!isRecord(row.callSite)) return [];
    const filePath = optionalString(row.callSite.filePath);
    if (filePath === undefined) return [];
    const subject = optionalString(row.ownerSymbolId) ?? filePath;
    const confidence = optionalString(row.confidence);
    const resolution = optionalString(row.resolution);
    const rowTargetHashes = boundedTargetHashes(row.targetHashes);
    const targetLinked =
      attribution === 'owner-only' && rowTargetHashes.some((hash) => targetHashes.has(hash));
    const column = optionalNumber(row.callSite.column);
    const line = optionalNumber(row.callSite.line);
    return [
      {
        attribution: attribution === 'owner-only' ? attribution : 'unknown',
        ...(column === undefined ? {} : { column }),
        ...(confidence === undefined ? {} : { confidence }),
        evidenceKind: targetLinked
          ? 'target-linked-unresolved-call-site'
          : 'owner-only-unresolved-call-site',
        filePath,
        kind: 'evidence',
        ...(line === undefined ? {} : { line }),
        ...(resolution === undefined ? {} : { resolution }),
        subject,
        targetHashes: rowTargetHashes,
      },
    ];
  });
}

function extractCallerNodes(payload: unknown): readonly AnswerFact[] {
  if (!isRecord(payload) || !isRecord(payload.data)) return [];
  const nodes = payload.data.nodes;
  const nodeFacts = records(nodes).flatMap(callerNodeFacts);
  return uniqueFacts([
    ...nodeFacts,
    ...unresolvedCallerFacts(
      payload.data.unresolved,
      targetBodyHashes(nodes),
      payload.data.unresolvedAttribution,
    ),
  ]);
}

export function extractWhoCallers(payload: unknown): readonly AnswerFact[] {
  return extractCallerNodes(payload);
}
