import {
  REVIEW_BRIEF_CORRELATION_ENTITY_LIMIT,
  REVIEW_BRIEF_CORRELATION_KEY_LIMIT,
  REVIEW_BRIEF_CORRELATION_KEY_PRIORITY,
} from '@opensip-cli/contracts';

import { compareCodePoint } from './review-brief-correlation-order.js';

import type { ReviewBriefCorrelationKey, ReviewBriefEntityRef } from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

const MAX_CORRELATION_STRING_LENGTH = 240;
const ENTITY_SOURCE_SIGNAL = 'signal';
const ENTITY_SOURCE_METADATA_PACKAGE = 'metadata.package';
const ENTITY_SOURCE_SIGNAL_FILE_PATH = 'signal.filePath';

interface PackageCandidate {
  readonly value: string;
  readonly source: string;
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_CORRELATION_STRING_LENGTH
    ? trimmed.slice(0, MAX_CORRELATION_STRING_LENGTH)
    : trimmed;
}

function safeStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => safeString(item))
    .filter((item): item is string => item !== undefined)
    .slice(0, REVIEW_BRIEF_CORRELATION_ENTITY_LIMIT);
}

function normalizedPath(value: string): string {
  return value.replaceAll('\\', '/');
}

function metadataString(signal: Signal, key: string): string | undefined {
  return safeString(signal.metadata[key]);
}

function packageFromPath(path: string): string | undefined {
  const normalized = normalizedPath(path);
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return undefined;
  const segment = normalized.split('/')[0];
  return safeString(segment);
}

function signalInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function fileRangeId(input: {
  readonly file: string;
  readonly line: number;
  readonly column?: number;
}): string {
  const suffix = input.column === undefined ? '' : `:${String(input.column)}`;
  return `${input.file}:${String(input.line)}${suffix}`;
}

function addUniqueEntity(out: ReviewBriefEntityRef[], entity: ReviewBriefEntityRef): void {
  if (out.some((existing) => existing.kind === entity.kind && existing.id === entity.id)) return;
  if (out.length >= REVIEW_BRIEF_CORRELATION_ENTITY_LIMIT) return;
  out.push(entity);
}

function addUniqueKey(out: ReviewBriefCorrelationKey[], key: ReviewBriefCorrelationKey): void {
  if (out.some((existing) => existing.kind === key.kind && existing.value === key.value)) return;
  out.push(key);
}

function addFingerprintEntity(entities: ReviewBriefEntityRef[], signal: Signal): void {
  const fingerprint = safeString(signal.fingerprint);
  if (!fingerprint) return;
  addUniqueEntity(entities, {
    kind: 'fingerprint',
    id: fingerprint,
    label: 'baseline fingerprint',
    source: ENTITY_SOURCE_SIGNAL,
    confidence: 'high',
  });
}

function addFileEntities(
  entities: ReviewBriefEntityRef[],
  file: string | undefined,
  line: number | undefined,
  signal: Signal,
): void {
  if (!file) return;
  const normalized = normalizedPath(file);
  addUniqueEntity(entities, {
    kind: 'file',
    id: normalized,
    label: normalized,
    file: normalized,
    source: ENTITY_SOURCE_SIGNAL,
    confidence: 'low',
  });
  if (line === undefined) return;
  const column = signalInteger(signal.column);
  const id = fileRangeId({ file: normalized, line, ...(column === undefined ? {} : { column }) });
  addUniqueEntity(entities, {
    kind: 'file-range',
    id,
    label: id,
    file: normalized,
    line,
    source: ENTITY_SOURCE_SIGNAL,
    confidence: 'medium',
  });
}

function addSymbolEntity(
  entities: ReviewBriefEntityRef[],
  signal: Signal,
  file: string | undefined,
  line: number | undefined,
): void {
  const qualifiedName = metadataString(signal, 'qualifiedName');
  if (!qualifiedName) return;
  addUniqueEntity(entities, {
    kind: 'symbol',
    id: qualifiedName,
    label: qualifiedName,
    file,
    line,
    source: 'metadata.qualifiedName',
    confidence: 'high',
  });
}

function addGraphNodeEntity(input: {
  readonly entities: ReviewBriefEntityRef[];
  readonly id: string;
  readonly label: string;
  readonly source: string;
  readonly file?: string;
  readonly line?: number;
}): void {
  addUniqueEntity(input.entities, {
    kind: 'graph-node',
    id: input.id,
    label: input.label,
    file: input.file,
    line: input.line,
    source: input.source,
    confidence: 'high',
  });
}

function addGraphNodeEntities(
  entities: ReviewBriefEntityRef[],
  signal: Signal,
  file: string | undefined,
  line: number | undefined,
): void {
  const bodyHash = metadataString(signal, 'bodyHash');
  if (bodyHash) {
    addGraphNodeEntity({
      entities,
      id: `body:${bodyHash}`,
      label: bodyHash,
      source: 'metadata.bodyHash',
      file,
      line,
    });
  }
  const sccId = metadataString(signal, 'sccId');
  if (sccId) {
    addGraphNodeEntity({
      entities,
      id: `scc:${sccId}`,
      label: sccId,
      source: 'metadata.sccId',
      file,
      line,
    });
  }
}

function addPackageCandidatesFromMetadata(
  signal: Signal,
  key: string,
  out: PackageCandidate[],
): void {
  for (const value of safeStringArray(signal.metadata[key])) {
    out.push({ value, source: `metadata.${key}` });
  }
}

function packageCandidates(signal: Signal, file: string | undefined): readonly PackageCandidate[] {
  const candidates: PackageCandidate[] = [];
  addPackageCandidatesFromMetadata(signal, 'packages', candidates);
  addPackageCandidatesFromMetadata(signal, 'relatedPackageCycle', candidates);
  const explicitPackage = metadataString(signal, 'package');
  if (explicitPackage !== undefined) {
    candidates.push({ value: explicitPackage, source: ENTITY_SOURCE_METADATA_PACKAGE });
  }
  const filePackage = file ? packageFromPath(file) : undefined;
  if (filePackage !== undefined) {
    candidates.push({ value: filePackage, source: ENTITY_SOURCE_SIGNAL_FILE_PATH });
  }
  return candidates;
}

function addPackageEntities(
  entities: ReviewBriefEntityRef[],
  signal: Signal,
  file: string | undefined,
): void {
  for (const candidate of packageCandidates(signal, file)) {
    if (candidate.value.startsWith('/') || /^[A-Za-z]:\//.test(candidate.value)) continue;
    addUniqueEntity(entities, {
      kind: 'package',
      id: candidate.value,
      label: candidate.value,
      source: candidate.source,
      confidence: 'low',
    });
  }
}

/** Project a signal into bounded entity refs used by review-brief correlation. */
export function reviewBriefEntities(signal: Signal): readonly ReviewBriefEntityRef[] {
  const entities: ReviewBriefEntityRef[] = [];
  const file = safeString(signal.filePath);
  const line = signalInteger(signal.line);
  addFingerprintEntity(entities, signal);
  addFileEntities(entities, file, line, signal);
  addSymbolEntity(entities, signal, file, line);
  addGraphNodeEntities(entities, signal, file, line);
  addPackageEntities(entities, signal, file);

  return entities;
}

/** Project a signal and entity refs into deterministic correlation keys. */
export function reviewBriefCorrelationKeys(
  signal: Signal,
  entities: readonly ReviewBriefEntityRef[],
): readonly ReviewBriefCorrelationKey[] {
  const keys: ReviewBriefCorrelationKey[] = [];
  for (const entity of entities) {
    if (entity.kind === 'fingerprint') {
      addUniqueKey(keys, { kind: 'fingerprint', value: entity.id, confidence: 'high' });
    } else if (entity.kind === 'graph-node') {
      addUniqueKey(keys, { kind: 'graph-node', value: entity.id, confidence: 'high' });
    } else if (entity.kind === 'symbol') {
      addUniqueKey(keys, { kind: 'symbol', value: entity.id, confidence: 'high' });
    } else if (entity.kind === 'file-range') {
      addUniqueKey(keys, { kind: 'file-range', value: entity.id, confidence: 'medium' });
    } else if (entity.kind === 'package') {
      addUniqueKey(keys, { kind: 'package', value: entity.id, confidence: 'low' });
    } else if (entity.kind === 'file') {
      addUniqueKey(keys, { kind: 'file', value: entity.id, confidence: 'low' });
    }
  }
  const file = safeString(signal.filePath);
  if (file) {
    const line = signalInteger(signal.line);
    const column = signalInteger(signal.column);
    const normalized = normalizedPath(file);
    addUniqueKey(keys, {
      kind: 'rule-location',
      value: `${signal.ruleId}|${normalized}|${String(line ?? '')}|${String(column ?? '')}`,
      confidence: 'high',
    });
  }
  const sortedKeys = [...keys];
  sortedKeys.sort(compareCorrelationKeys);
  return sortedKeys.slice(0, REVIEW_BRIEF_CORRELATION_KEY_LIMIT);
}

function compareCorrelationKeys(
  left: ReviewBriefCorrelationKey,
  right: ReviewBriefCorrelationKey,
): number {
  const priority =
    REVIEW_BRIEF_CORRELATION_KEY_PRIORITY[left.kind] -
    REVIEW_BRIEF_CORRELATION_KEY_PRIORITY[right.kind];
  if (priority !== 0) return priority;
  return compareCodePoint(left.value, right.value);
}
