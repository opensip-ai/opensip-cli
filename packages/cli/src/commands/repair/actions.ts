import { err, ok, type Result, type Signal, type SignalRepairAction } from '@opensip-cli/core';

import { unifiedDiff } from './diff.js';
import { readSafeTextFile, sha256Text } from './path-safety.js';

import type { RepairError, RepairPlannedFileChange } from './types.js';
import type { RepairRefusal } from '@opensip-cli/contracts';

interface ActionPlanDetails {
  readonly status: 'previewed' | 'already-applied' | 'refused';
  readonly changes: readonly RepairPlannedFileChange[];
  readonly refusal?: RepairRefusal;
  readonly verification?: SignalRepairAction['verification'];
}

interface ActionInput {
  readonly projectRoot: string;
  readonly signal: Signal;
  readonly action: SignalRepairAction;
}

function repairError(code: string, message: string): RepairError {
  return { code, message };
}

function refusal(code: string, message: string): ActionPlanDetails {
  return { status: 'refused', changes: [], refusal: { code, message } };
}

function targetString(action: SignalRepairAction, key: string): string | undefined {
  const value = action.target?.[key];
  return typeof value === 'string' ? value : undefined;
}

function targetNumber(action: SignalRepairAction, key: string): number | undefined {
  const value = action.target?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function targetPath(signal: Signal, action: SignalRepairAction): string | undefined {
  return targetString(action, 'filePath') ?? action.patchHint?.target ?? signal.filePath;
}

function splitContentLines(content: string): {
  readonly lines: string[];
  readonly endings: string[];
} {
  return {
    lines: content.split(/\r\n|\n|\r/u),
    endings: content.match(/\r\n|\n|\r/gu) ?? [],
  };
}

function joinContentLines(lines: readonly string[], endings: readonly string[]): string {
  return lines.map((line, index) => `${line}${endings[index] ?? ''}`).join('');
}

function plannedChange(
  absolutePath: string,
  relativePath: string,
  before: string,
  after: string,
): RepairPlannedFileChange {
  const beforeHash = sha256Text(before);
  const afterHash = sha256Text(after);
  return {
    absolutePath,
    filePath: relativePath,
    status: before === after ? 'unchanged' : 'modified',
    beforeHash,
    afterHash,
    diff: unifiedDiff(relativePath, before, after),
    afterContent: after,
  };
}

function statusFor(changes: readonly RepairPlannedFileChange[]): ActionPlanDetails['status'] {
  return changes.some((change) => change.status === 'modified') ? 'previewed' : 'already-applied';
}

function replaceTsIgnore(input: ActionInput): Result<ActionPlanDetails, RepairError> {
  const rawPath = targetPath(input.signal, input.action);
  const line = targetNumber(input.action, 'line') ?? input.signal.line;
  const expectedText = targetString(input.action, 'expectedText');
  const replacementText = targetString(input.action, 'replacementText');

  if (rawPath === undefined || line === undefined || line < 1 || expectedText === undefined) {
    return err(
      repairError(
        'invalid-target',
        'replace-ts-ignore action requires filePath, line, and expectedText target metadata',
      ),
    );
  }
  if (replacementText === undefined) {
    return err(
      repairError('invalid-target', 'replace-ts-ignore action requires replacementText metadata'),
    );
  }

  const file = readSafeTextFile(input.projectRoot, rawPath);
  if (!file.ok) return file;

  const { lines, endings } = splitContentLines(file.value.content);
  const index = line - 1;
  const current = lines[index];
  if (current === undefined) {
    return err(
      repairError(
        'stale-file',
        `target line ${line.toString()} is no longer present in ${file.value.relativePath}`,
      ),
    );
  }

  if (!current.includes(expectedText)) {
    if (current.includes(replacementText)) {
      const change = plannedChange(
        file.value.absolutePath,
        file.value.relativePath,
        file.value.content,
        file.value.content,
      );
      return ok({
        status: 'already-applied',
        changes: [change],
        verification: input.action.verification,
      });
    }
    return err(
      repairError(
        'stale-file',
        `expected text was not found on ${file.value.relativePath}:${line.toString()}`,
      ),
    );
  }

  lines[index] = current.replace(expectedText, replacementText);
  const after = joinContentLines(lines, endings);
  const change = plannedChange(
    file.value.absolutePath,
    file.value.relativePath,
    file.value.content,
    after,
  );
  return ok({
    status: statusFor([change]),
    changes: [change],
    verification: input.action.verification,
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findSectionBounds(
  lines: readonly string[],
  section: string,
): { readonly start: number; readonly end: number } | undefined {
  const sectionPattern = new RegExp(`^\\s*"${escapeRegex(section)}"\\s*:\\s*\\{`);
  const start = lines.findIndex((line) => sectionPattern.test(line));
  if (start === -1) return undefined;

  let depth = 0;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    depth += (line.match(/\{/g) ?? []).length;
    depth -= (line.match(/}/g) ?? []).length;
    if (index > start && depth === 0) return { start, end: index };
  }
  return undefined;
}

function isDependencyLine(line: string): boolean {
  return /^\s*"[^"]+"\s*:/.test(line);
}

type DependencySection = 'dependencies' | 'devDependencies';

interface DependencyTarget {
  readonly rawPath: string;
  readonly packageName: string;
  readonly dependencySection: DependencySection;
}

function dependencyTarget(input: ActionInput): Result<DependencyTarget, RepairError> {
  const rawPath = targetPath(input.signal, input.action);
  const packageName = targetString(input.action, 'packageName');
  const dependencySection = targetString(input.action, 'dependencySection');
  if (
    rawPath === undefined ||
    packageName === undefined ||
    (dependencySection !== 'dependencies' && dependencySection !== 'devDependencies')
  ) {
    return err(
      repairError(
        'invalid-target',
        'remove-unused-dependency action requires filePath, packageName, and dependencySection target metadata',
      ),
    );
  }
  return ok({ rawPath, packageName, dependencySection });
}

function parsePackageJsonSection(
  content: string,
  relativePath: string,
  dependencySection: DependencySection,
): Result<Record<string, unknown> | null, RepairError> {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const section = parsed[dependencySection];
    if (section === undefined) return ok(null);
    if (typeof section !== 'object' || section === null || Array.isArray(section)) {
      return err(
        repairError(
          'unsupported-layout',
          `${relativePath} ${dependencySection} must be a JSON object`,
        ),
      );
    }
    return ok(section as Record<string, unknown>);
  } catch {
    return err(repairError('invalid-target', `${relativePath} is not valid JSON`));
  }
}

function dependencyLineIndex(
  lines: readonly string[],
  bounds: { readonly start: number; readonly end: number },
  packageName: string,
): Result<number, RepairError> {
  const packagePattern = new RegExp(`^\\s*"${escapeRegex(packageName)}"\\s*:`);
  const matches: number[] = [];
  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    if (packagePattern.test(lines[index] ?? '')) matches.push(index);
  }
  if (matches.length !== 1 || matches[0] === undefined) {
    return err(repairError('unsupported-layout', `expected exactly one ${packageName} entry`));
  }
  return ok(matches[0]);
}

function removeDependencyLine(
  lines: string[],
  endings: string[],
  bounds: { readonly start: number; readonly end: number },
  removeIndex: number,
): void {
  const nextDependency = lines.findIndex(
    (line, index) => index > removeIndex && index < bounds.end && isDependencyLine(line),
  );
  if (!/,\s*$/.test(lines[removeIndex] ?? '') && nextDependency === -1) {
    for (let index = removeIndex - 1; index > bounds.start; index -= 1) {
      if (!isDependencyLine(lines[index] ?? '')) continue;
      lines[index] = (lines[index] ?? '').replace(/,\s*$/, '');
      break;
    }
  }
  lines.splice(removeIndex, 1);
  endings.splice(removeIndex, 1);
}

function validateJson(content: string, relativePath: string): Result<true, RepairError> {
  try {
    JSON.parse(content);
    return ok(true);
  } catch {
    return err(
      repairError('unsupported-layout', `repair would produce invalid JSON for ${relativePath}`),
    );
  }
}

function removePackageJsonDependency(input: ActionInput): Result<ActionPlanDetails, RepairError> {
  const target = dependencyTarget(input);
  if (!target.ok) return target;

  const file = readSafeTextFile(input.projectRoot, target.value.rawPath);
  if (!file.ok) return file;

  const section = parsePackageJsonSection(
    file.value.content,
    file.value.relativePath,
    target.value.dependencySection,
  );
  if (!section.ok) return section;

  if (section.value?.[target.value.packageName] === undefined) {
    const change = plannedChange(
      file.value.absolutePath,
      file.value.relativePath,
      file.value.content,
      file.value.content,
    );
    return ok({
      status: 'already-applied',
      changes: [change],
      verification: input.action.verification,
    });
  }

  const { lines, endings } = splitContentLines(file.value.content);
  const bounds = findSectionBounds(lines, target.value.dependencySection);
  if (bounds === undefined) {
    return err(
      repairError(
        'unsupported-layout',
        `${file.value.relativePath} ${target.value.dependencySection} must be a multiline JSON object`,
      ),
    );
  }

  const removeIndex = dependencyLineIndex(lines, bounds, target.value.packageName);
  if (!removeIndex.ok) {
    return err(
      repairError(
        removeIndex.error.code,
        `${removeIndex.error.message} in ${file.value.relativePath} ${target.value.dependencySection}`,
      ),
    );
  }

  removeDependencyLine(lines, endings, bounds, removeIndex.value);
  const after = joinContentLines(lines, endings);
  const validJson = validateJson(after, file.value.relativePath);
  if (!validJson.ok) return validJson;

  const change = plannedChange(
    file.value.absolutePath,
    file.value.relativePath,
    file.value.content,
    after,
  );
  return ok({
    status: statusFor([change]),
    changes: [change],
    verification: input.action.verification,
  });
}

export function executeRepairAction(input: ActionInput): Result<ActionPlanDetails, RepairError> {
  if (!input.action.autofixable) {
    return ok(
      refusal(
        'action-not-autofixable',
        `repair action '${input.action.id}' is advisory and cannot be applied automatically`,
      ),
    );
  }

  switch (input.action.id) {
    case 'replace-ts-ignore': {
      return replaceTsIgnore(input);
    }
    case 'remove-unused-dependency': {
      return removePackageJsonDependency(input);
    }
    case 'normalize-generated-config': {
      return ok(
        refusal(
          'action-reserved',
          'normalize-generated-config is reserved until a concrete signal producer supplies a safe target',
        ),
      );
    }
    default: {
      return ok(
        refusal(
          'action-unsupported',
          `repair action '${input.action.id}' is not supported by this CLI`,
        ),
      );
    }
  }
}
