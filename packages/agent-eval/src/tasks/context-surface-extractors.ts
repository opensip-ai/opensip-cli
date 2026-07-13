import { assessImpactTrust, assessTestSelectionTrust } from '../model/context-surface-trust.js';
import { isUnknownRecord as isRecord, uniqueFacts } from '../model/value-helpers.js';

import type { AnswerFact, ProofClosureAssessor, ResponseExtractor } from '../model/task.js';
import type { UnknownRecord } from '../model/value-helpers.js';

function dataRecord(payload: unknown): UnknownRecord | undefined {
  return isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
}

function records(value: unknown): readonly UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function simpleName(value: unknown): string | undefined {
  const qualified = nonEmptyString(value);
  if (qualified === undefined) return undefined;
  return qualified.split(/[.#]/u).at(-1) ?? qualified;
}

function isSelectedTest(value: unknown): value is UnknownRecord {
  if (!isRecord(value)) return false;
  return (
    nonEmptyString(value.path) !== undefined &&
    (value.basis === 'direct-call' ||
      value.basis === 'transitive-call' ||
      value.basis === 'module-import' ||
      value.basis === 'target-convention' ||
      value.basis === 'co-located') &&
    (value.confidence === 'exact' ||
      value.confidence === 'high' ||
      value.confidence === 'medium' ||
      value.confidence === 'low') &&
    stringArray(value.proof) &&
    value.observed === false
  );
}

function isVerificationCommand(value: unknown): value is UnknownRecord {
  if (!isRecord(value)) return false;
  return (
    nonEmptyString(value.cwd) !== undefined &&
    nonEmptyString(value.basis) !== undefined &&
    (value.tier === 'focused' || value.tier === 'package' || value.tier === 'full') &&
    stringArray(value.argv) &&
    value.argv.length > 0 &&
    value.argv.every((argument) => argument.length > 0)
  );
}

function appendImpactFileFacts(value: unknown, facts: AnswerFact[]): void {
  if (!Array.isArray(value)) return;
  for (const path of value) {
    if (typeof path === 'string' && path.length > 0) {
      facts.push({ kind: 'file', path, role: 'impacted' });
    }
  }
}

function appendImpactFunctionFacts(value: unknown, facts: AnswerFact[]): void {
  for (const fn of records(value)) {
    const filePath = nonEmptyString(fn.filePath);
    const name = simpleName(fn.simpleName ?? fn.qualifiedName);
    const packageName = nonEmptyString(fn.package);
    if (filePath !== undefined) facts.push({ kind: 'file', path: filePath, role: 'caller' });
    if (name !== undefined) {
      facts.push({
        kind: 'symbol',
        name,
        ...(filePath === undefined ? {} : { filePath }),
        ...(packageName === undefined ? {} : { package: packageName }),
      });
    }
    if (packageName !== undefined) facts.push({ kind: 'package', name: packageName });
  }
}

function appendImpactPackageFacts(value: unknown, facts: AnswerFact[]): void {
  for (const pkg of records(value)) {
    const name = nonEmptyString(pkg.name);
    if (name !== undefined) facts.push({ kind: 'package', name });
  }
}

/** Normalize the explicit-file impact response without inventing edge confidence. */
export function extractImpactFiles(payload: unknown): readonly AnswerFact[] {
  const trust = assessImpactTrust(payload);
  // Qualified positive rows remain useful under valid partial trust. Only a
  // negative proof requires full verification; dropping positive rows here
  // turns an honest approximate graph into a false empty answer.
  if (!trust.valid) return [];
  const data = dataRecord(payload);
  if (data === undefined) return [];
  const facts: AnswerFact[] = [];
  appendImpactFileFacts(data.impactedFiles, facts);
  appendImpactFunctionFacts(data.impactedFunctions, facts);
  appendImpactPackageFacts(data.impactedPackages, facts);
  return uniqueFacts(facts);
}

function fallbackCommandPurpose(basis: string | undefined): string | undefined {
  if (
    basis?.startsWith('package-manager-script:') === true ||
    basis?.includes('wrapper') === true ||
    basis?.includes('convention') === true
  ) {
    return 'fallback';
  }
  const marker = basis?.match(/manifest-script:([^:]+)/u)?.[1];
  return marker;
}

function selectionCommandPurpose(basis: string | undefined): string | undefined {
  const purpose = fallbackCommandPurpose(basis);
  return purpose === 'test' ? 'test-script' : purpose;
}

/** Project selected static tests and safe argv commands into stable answer facts. */
export function extractTestSelection(payload: unknown): readonly AnswerFact[] {
  const data = dataRecord(payload);
  if (data === undefined) return [];
  const facts: AnswerFact[] = [];
  for (const test of Array.isArray(data.tests) ? data.tests.filter(isSelectedTest) : []) {
    const path = nonEmptyString(test.path);
    if (path !== undefined) facts.push({ kind: 'file', path, role: 'test' });
  }
  for (const command of Array.isArray(data.commands)
    ? data.commands.filter(isVerificationCommand)
    : []) {
    const argv = command.argv as readonly string[];
    const purpose = selectionCommandPurpose(nonEmptyString(command.basis));
    facts.push({
      command: argv.join(' '),
      kind: 'command',
      ...(purpose === undefined ? {} : { purpose }),
    });
  }
  return uniqueFacts(facts);
}

/** Build a request-bound assessor for the selector's bounded candidate domain. */
export function createTestSelectionProofAssessor(
  expectedFiles: readonly string[],
): ProofClosureAssessor {
  return (payload) => {
    const assessment = assessTestSelectionTrust(payload, expectedFiles);
    if (!assessment.valid) {
      return {
        projectionComplete: false,
        domainExhausted: false,
        reasonCodes: ['malformed-test-selection'],
      };
    }
    return {
      projectionComplete: true,
      domainExhausted: assessment.complete,
      reasonCodes:
        assessment.complete || assessment.reasonCodes.length > 0
          ? assessment.reasonCodes
          : ['test-selection-incomplete'],
    };
  };
}

function projectManager(project: UnknownRecord, facts: AnswerFact[]): void {
  if (Number.isSafeInteger(project.packageCount) && (project.packageCount as number) >= 0) {
    facts.push({ kind: 'count', label: 'packages', value: project.packageCount as number });
  }
  const declaration = nonEmptyString(project.packageManager);
  if (declaration === undefined) return;
  const separator = declaration.lastIndexOf('@');
  const manager = separator > 0 ? declaration.slice(0, separator) : declaration;
  facts.push(
    { kind: 'text', label: 'package-manager', value: manager },
    { kind: 'text', label: 'package-manager-declaration', value: declaration },
  );
}

function projectPackage(pkg: UnknownRecord, facts: AnswerFact[]): void {
  const name = nonEmptyString(pkg.name);
  if (name !== undefined) facts.push({ kind: 'package', name });
  for (const command of Array.isArray(pkg.verificationCommands)
    ? pkg.verificationCommands.filter(isVerificationCommand)
    : []) {
    const argv = command.argv as readonly string[];
    const basis = nonEmptyString(command.basis);
    const purpose = fallbackCommandPurpose(basis);
    facts.push({
      command: argv.join(' '),
      kind: 'command',
      ...(purpose === undefined ? {} : { purpose }),
    });
  }
}

/** Build an extractor for one explicit file-context request. */
export function extractFileContext(requestedFile: string): ResponseExtractor {
  return (payload) => {
    const data = isRecord(payload) ? payload : undefined;
    if (data === undefined) return [];
    const facts: AnswerFact[] = [];
    if (data.status === 'found') {
      const path = isRecord(data.file) ? nonEmptyString(data.file.path) : undefined;
      if (path === requestedFile) facts.push({ kind: 'file', path, role: 'inventory' });
    }
    if (isRecord(data.project)) projectManager(data.project, facts);
    if (isRecord(data.package)) projectPackage(data.package, facts);
    return uniqueFacts(facts);
  };
}
