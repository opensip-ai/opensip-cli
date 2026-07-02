import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import { assertSupportedLanguage } from './config.mjs';

export async function loadQualityCorpus({ roots, config, checkIndex }) {
  const cases = [];
  const seen = new Set();
  for (const root of roots) {
    const manifestPath = resolve(root);
    const manifestDir = dirname(manifestPath);
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const caseRecord of normalizeManifest(
      parsed,
      manifestPath,
      manifestDir,
      config,
      checkIndex,
    )) {
      if (seen.has(caseRecord.id)) {
        throw new Error(`Duplicate quality corpus case id ${caseRecord.id}.`);
      }
      seen.add(caseRecord.id);
      cases.push(caseRecord);
    }
  }
  if (cases.length > config.maxCases) {
    throw new Error(
      `Quality corpus has ${String(cases.length)} cases, above maxCases ${String(config.maxCases)}.`,
    );
  }
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeManifest(parsed, manifestPath, manifestDir, config, checkIndex) {
  if (!isRecord(parsed))
    throw new Error(`Invalid quality corpus ${manifestPath}: root must be an object.`);
  if (parsed.version !== 1)
    throw new Error(`Invalid quality corpus ${manifestPath}: version must be 1.`);
  if (!Array.isArray(parsed.cases)) {
    throw new TypeError(`Invalid quality corpus ${manifestPath}: cases must be an array.`);
  }
  return parsed.cases.map((entry, index) =>
    normalizeCase(entry, {
      index,
      manifestPath,
      manifestDir,
      config,
      checkIndex,
      corpusId: typeof parsed.id === 'string' ? parsed.id : relative(process.cwd(), manifestPath),
    }),
  );
}

function normalizeCase(entry, context) {
  if (!isRecord(entry)) {
    throw new Error(
      `Invalid quality corpus ${context.manifestPath}: cases[${context.index}] must be an object.`,
    );
  }
  const id = stringValue(entry.id, `cases[${context.index}].id`);
  const language = stringValue(entry.language, `cases[${context.index}].language`);
  assertSupportedLanguage(language, `cases[${context.index}].language`);
  const files = normalizeFiles(entry.files, context, id);
  const filePaths = new Set(files.map((file) => file.path));
  const targetPaths = stringArray(
    entry.targetPaths ?? files.map((file) => file.path),
    `cases[${context.index}].targetPaths`,
  );
  for (const targetPath of targetPaths) {
    if (!filePaths.has(targetPath)) {
      throw new Error(
        `Invalid quality corpus case ${id}: target path ${targetPath} is not one of the case files.`,
      );
    }
  }
  const checks = normalizeChecks(entry.checks, context, id);
  return {
    id,
    corpus: context.corpusId,
    language,
    rationale: typeof entry.rationale === 'string' ? entry.rationale : '',
    files,
    targetPaths,
    checks,
  };
}

function normalizeFiles(files, context, caseId) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`Invalid quality corpus case ${caseId}: files must be a non-empty array.`);
  }
  const seen = new Set();
  return files.map((file, index) => {
    if (!isRecord(file))
      throw new Error(`Invalid quality corpus case ${caseId}: files[${index}] must be an object.`);
    const path = stringValue(file.path, `cases[${context.index}].files[${index}].path`);
    if (path.includes('\0'))
      throw new Error(`Invalid quality corpus case ${caseId}: file path contains NUL.`);
    const resolved = resolve(context.manifestDir, path);
    const relativePath = relative(context.manifestDir, resolved);
    if (relativePath === '' || relativePath.startsWith('..') || relativePath !== path) {
      throw new Error(
        `Invalid quality corpus case ${caseId}: file path ${path} escapes the corpus root.`,
      );
    }
    if (seen.has(path))
      throw new Error(`Invalid quality corpus case ${caseId}: duplicate file path ${path}.`);
    seen.add(path);
    const content = stringValue(file.content, `cases[${context.index}].files[${index}].content`);
    if (Buffer.byteLength(content, 'utf8') > context.config.maxFixtureBytes) {
      throw new Error(
        `Invalid quality corpus case ${caseId}: file ${path} exceeds maxFixtureBytes.`,
      );
    }
    return { path, content };
  });
}

function normalizeChecks(checks, context, caseId) {
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new Error(`Invalid quality corpus case ${caseId}: checks must be a non-empty array.`);
  }
  const seen = new Set();
  return checks.map((entry, index) => {
    if (!isRecord(entry))
      throw new TypeError(
        `Invalid quality corpus case ${caseId}: checks[${index}] must be an object.`,
      );
    const slug = stringValue(entry.slug, `cases[${context.index}].checks[${index}].slug`);
    if (seen.has(slug))
      throw new Error(`Invalid quality corpus case ${caseId}: duplicate check slug ${slug}.`);
    seen.add(slug);
    if (context.checkIndex && !context.checkIndex.bySlug.has(slug)) {
      throw new Error(`Invalid quality corpus case ${caseId}: unknown check slug ${slug}.`);
    }
    if (typeof entry.expectFinding !== 'boolean') {
      throw new TypeError(
        `Invalid quality corpus case ${caseId}: checks[${index}].expectFinding must be boolean.`,
      );
    }
    return { slug, expectFinding: entry.expectFinding };
  });
}

function stringArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid quality corpus: ${name} must be a non-empty string array.`);
  }
  return value.map((entry, index) => stringValue(entry, `${name}[${index}]`));
}

function stringValue(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid quality corpus: ${name} must be a non-empty string.`);
  }
  return value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
