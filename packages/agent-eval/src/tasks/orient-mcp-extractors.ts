import { isUnknownRecord as isRecord, uniqueStrings } from '../model/value-helpers.js';

import { responseDataRecord } from './task-response-extractors.js';

import type { AnswerFact } from '../model/task.js';

export function extractArchitecture(payload: unknown): readonly AnswerFact[] {
  const data = responseDataRecord(payload);
  if (data === undefined) return [];
  const facts: AnswerFact[] = [];
  if (isRecord(data.packageCount) && typeof data.packageCount.value === 'number') {
    facts.push({
      kind: 'count',
      label: 'packages',
      value: data.packageCount.value,
    });
  }
  if (Array.isArray(data.languages)) {
    for (const language of data.languages) {
      if (typeof language === 'string') {
        facts.push({ kind: 'text', label: 'language', value: language });
      }
    }
  }
  return facts;
}

function packageNamesFromRows(rows: unknown): readonly string[] {
  if (!Array.isArray(rows)) return [];
  const names: string[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (typeof row.fromPackage === 'string') names.push(row.fromPackage);
    if (typeof row.toPackage === 'string') names.push(row.toPackage);
  }
  return names;
}

export function extractPackageDependencies(payload: unknown): readonly AnswerFact[] {
  const data = responseDataRecord(payload);
  if (data === undefined) return [];
  const packages = uniqueStrings([
    ...packageNamesFromRows(data.calls),
    ...packageNamesFromRows(data.imports),
  ]);
  return packages.map((name) => ({ kind: 'package', name }));
}
