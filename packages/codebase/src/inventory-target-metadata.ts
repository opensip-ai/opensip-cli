import { isPlainRecord, tryCatch } from '@opensip-cli/core';

import { buildFileRoleTargetProjection } from './file-roles.js';
import { byCodePoint } from './freeze.js';
import { CONTROL_CHARACTER } from './inventory-helpers.js';
import {
  MAX_FILE_LANGUAGES,
  MAX_INVENTORY_TARGETS,
  MAX_TARGET_CONVENTION_PATH_LENGTH,
  MAX_TARGET_CONVENTION_PATHS,
  MAX_TARGET_METADATA_TEXT,
  MAX_TARGET_METADATA_VALUES,
  MAX_TARGET_NAME,
} from './types.js';

import type { BoundedTarget } from './inventory-file-model.js';
import type { BoundedTargetResolver, TargetView } from '@opensip-cli/core';

const TARGET_METADATA_CAP_REASON = 'target-metadata-cap-reached';
const TARGET_METADATA_INVALID_REASON = 'target-metadata-invalid';

export type TargetProjection =
  | { readonly status: 'invalid' }
  | { readonly status: 'capped' }
  | { readonly status: 'ok'; readonly targets: BoundedTarget[] };

function boundedText(value: unknown, maximum: number, fatalReasons: Set<string>): value is string {
  if (typeof value !== 'string') {
    fatalReasons.add(TARGET_METADATA_INVALID_REASON);
    return false;
  }
  if (value.length > maximum) {
    fatalReasons.add(TARGET_METADATA_CAP_REASON);
    return false;
  }
  return true;
}

function boundedMetadataValues(
  value: unknown,
  fatalReasons: Set<string>,
): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fatalReasons.add(TARGET_METADATA_INVALID_REASON);
    return undefined;
  }
  const valueCount = value.length;
  if (typeof valueCount !== 'number' || !Number.isSafeInteger(valueCount) || valueCount < 0) {
    fatalReasons.add(TARGET_METADATA_INVALID_REASON);
    return undefined;
  }
  if (valueCount > MAX_TARGET_METADATA_VALUES) {
    fatalReasons.add(TARGET_METADATA_CAP_REASON);
    return undefined;
  }
  const values: string[] = [];
  const candidates = Array.from({ length: valueCount }, (_, index): unknown => value[index]);
  for (const candidate of candidates) {
    if (!boundedText(candidate, MAX_TARGET_METADATA_TEXT, fatalReasons)) return undefined;
    values.push(candidate);
  }
  return values;
}

function boundedOptionalArray(
  value: unknown,
  maximum: number,
  fatalReasons: Set<string>,
): readonly unknown[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fatalReasons.add(TARGET_METADATA_INVALID_REASON);
    return undefined;
  }
  const valueCount = value.length;
  if (typeof valueCount !== 'number' || !Number.isSafeInteger(valueCount) || valueCount < 0) {
    fatalReasons.add(TARGET_METADATA_INVALID_REASON);
    return undefined;
  }
  if (valueCount > maximum) {
    fatalReasons.add(TARGET_METADATA_CAP_REASON);
    return undefined;
  }
  return Array.from({ length: valueCount }, (_, index): unknown => value[index]);
}

function boundedConventionPaths(
  conventions: TargetView['config']['conventions'],
  fatalReasons: Set<string>,
): readonly string[] | undefined {
  if (conventions === undefined) return [];
  if (!isPlainRecord(conventions)) {
    fatalReasons.add(TARGET_METADATA_INVALID_REASON);
    return undefined;
  }
  const entrypoints = boundedOptionalArray(
    conventions.entrypoints,
    MAX_TARGET_CONVENTION_PATHS,
    fatalReasons,
  );
  const alwaysUsed = boundedOptionalArray(
    conventions.alwaysUsed,
    MAX_TARGET_CONVENTION_PATHS,
    fatalReasons,
  );
  const usedExports = boundedOptionalArray(
    conventions.usedExports,
    MAX_TARGET_CONVENTION_PATHS,
    fatalReasons,
  );
  if (entrypoints === undefined || alwaysUsed === undefined || usedExports === undefined) {
    return undefined;
  }
  if (entrypoints.length + alwaysUsed.length + usedExports.length > MAX_TARGET_CONVENTION_PATHS) {
    fatalReasons.add(TARGET_METADATA_CAP_REASON);
    return undefined;
  }
  const paths: string[] = [];
  for (const candidate of [...entrypoints, ...alwaysUsed]) {
    if (!boundedText(candidate, MAX_TARGET_CONVENTION_PATH_LENGTH, fatalReasons)) return undefined;
    paths.push(candidate);
  }
  for (const candidate of usedExports) {
    if (!isPlainRecord(candidate)) {
      fatalReasons.add(TARGET_METADATA_INVALID_REASON);
      return undefined;
    }
    const file = candidate.file;
    if (!boundedText(file, MAX_TARGET_CONVENTION_PATH_LENGTH, fatalReasons)) {
      return undefined;
    }
    paths.push(file);
  }
  return paths;
}

function boundedTarget(
  target: TargetView,
  reasons: Set<string>,
  fatalReasons: Set<string>,
): BoundedTarget | undefined {
  const config = target.config;
  const name = config.name;
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > MAX_TARGET_NAME ||
    CONTROL_CHARACTER.test(name)
  ) {
    reasons.add('target-name-invalid');
    return undefined;
  }
  const tags = boundedMetadataValues(config.tags, fatalReasons);
  const concerns = boundedMetadataValues(config.concerns, fatalReasons);
  const languageValues = boundedMetadataValues(config.languages, fatalReasons);
  const conventionPaths = boundedConventionPaths(config.conventions, fatalReasons);
  if (
    tags === undefined ||
    concerns === undefined ||
    languageValues === undefined ||
    conventionPaths === undefined
  ) {
    return undefined;
  }
  const languages = new Set<string>();
  for (const language of languageValues) {
    if (
      typeof language !== 'string' ||
      language.length === 0 ||
      language.length > MAX_TARGET_NAME ||
      CONTROL_CHARACTER.test(language)
    ) {
      reasons.add('target-language-invalid');
      continue;
    }
    languages.add(language);
  }
  const sortedLanguages = [...languages].sort(byCodePoint);
  if (sortedLanguages.length > MAX_FILE_LANGUAGES) {
    reasons.add('file-language-cap-reached');
  }
  const roleProjection = buildFileRoleTargetProjection({
    name,
    tags,
    concerns,
    hasLanguage: sortedLanguages.length > 0,
    conventionPaths,
  });
  return Object.freeze({
    ...roleProjection,
    languages: Object.freeze(sortedLanguages.slice(0, MAX_FILE_LANGUAGES)),
  });
}

export function projectBoundedTargets(
  resolver: BoundedTargetResolver,
  reasons: Set<string>,
  fatalReasons: Set<string>,
): TargetProjection {
  const projection = tryCatch((): TargetProjection => {
    const targetViews: unknown = resolver.getAll();
    if (!Array.isArray(targetViews)) return { status: 'invalid' };
    const targetCount = targetViews.length;
    if (typeof targetCount !== 'number' || !Number.isSafeInteger(targetCount) || targetCount < 0) {
      return { status: 'invalid' };
    }
    if (targetCount > MAX_INVENTORY_TARGETS) return { status: 'capped' };
    const targets: BoundedTarget[] = [];
    const targetNames = new Set<string>();
    for (let index = 0; index < targetCount; index += 1) {
      const projected = boundedTarget(targetViews[index] as TargetView, reasons, fatalReasons);
      if (projected === undefined) continue;
      if (targetNames.has(projected.name)) {
        fatalReasons.add(TARGET_METADATA_INVALID_REASON);
        continue;
      }
      targetNames.add(projected.name);
      targets.push(projected);
    }
    return { status: 'ok', targets };
  });
  return projection.ok ? projection.value : { status: 'invalid' };
}
