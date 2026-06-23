import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';

import { getCheckConfig, type CheckViolation, type FileAccessor } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

import {
  DOMAIN_SPECIFIC_FUNCTION_NAMES,
  type DuplicateUtilityFunctionsConfig,
} from './duplicate-utility-functions-config.js';

const UTILITY_PATTERNS = [
  /^format[A-Z]/,
  /^parse[A-Z]/,
  /^is[A-Z]/,
  /^has[A-Z]/,
  /^to[A-Z]/,
  /^get[A-Z]/,
  /^validate[A-Z]/,
  /^sanitize[A-Z]/,
  /^normalize[A-Z]/,
  /^debounce/,
  /^throttle/,
  /^sleep/,
  /^delay/,
  /^retry/,
  /^clamp/,
  /^range/,
  /^chunk/,
  /^unique/,
  /^flatten/,
];

export const MIN_FUNCTION_BODY_LENGTH = 50;

const DOMAIN_SPECIFIC_FUNCTIONS = new Set<string>(DOMAIN_SPECIFIC_FUNCTION_NAMES);

export function buildEffectiveDomainSpecificSet(): ReadonlySet<string> {
  const cfg = getCheckConfig<DuplicateUtilityFunctionsConfig>('duplicate-utility-functions');
  if (
    !cfg.additionalDomainSpecificFunctions ||
    cfg.additionalDomainSpecificFunctions.length === 0
  ) {
    return DOMAIN_SPECIFIC_FUNCTIONS;
  }
  const merged = new Set(DOMAIN_SPECIFIC_FUNCTIONS);
  for (const name of cfg.additionalDomainSpecificFunctions) merged.add(name);
  return merged;
}

export interface FunctionInfo {
  name: string;
  line: number;
  file: string;
  bodyHash: string;
  bodyLength: number;
}

export type FunctionsByName = Map<string, Map<string, FunctionInfo[]>>;

function getUniqueDirectories(locations: FunctionInfo[]): Set<string> {
  if (!Array.isArray(locations)) {
    return new Set();
  }
  return new Set(locations.map((l) => dirname(l.file)));
}

function flattenHashGroups(hashGroups: Map<string, FunctionInfo[]>): FunctionInfo[] {
  const allLocations: FunctionInfo[] = [];
  if (hashGroups.size === 0) {
    return allLocations;
  }
  for (const locations of hashGroups.values()) {
    if (Array.isArray(locations) && locations.length > 0) {
      allLocations.push(...locations);
    }
  }
  return allLocations;
}

function getFirstFromEachHashGroup(hashGroups: Map<string, FunctionInfo[]>): FunctionInfo[] {
  const uniqueImpls: FunctionInfo[] = [];
  if (hashGroups.size === 0) {
    return uniqueImpls;
  }
  for (const locations of hashGroups.values()) {
    if (!Array.isArray(locations) || locations.length === 0) {
      continue;
    }
    const first = locations[0];
    if (first) {
      uniqueImpls.push(first);
    }
  }
  return uniqueImpls;
}

function formatOtherFiles(locations: FunctionInfo[]): string {
  const otherFiles = locations
    .slice(1)
    .map((l) => basename(l.file))
    .slice(0, 3);
  const moreCount = locations.length > 4 ? ` (+${locations.length - 4} more)` : '';
  return `${otherFiles.join(', ')}${moreCount}`;
}

function addFunctionToCollection(functionsByName: FunctionsByName, fn: FunctionInfo): void {
  let nameGroup = functionsByName.get(fn.name);
  if (!nameGroup) {
    nameGroup = new Map();
    functionsByName.set(fn.name, nameGroup);
  }

  let hashGroup = nameGroup.get(fn.bodyHash);
  if (!hashGroup) {
    hashGroup = [];
    nameGroup.set(fn.bodyHash, hashGroup);
  }

  hashGroup.push(fn);
}

function isValidCrossDirectoryDuplicate(locations: FunctionInfo[]): boolean {
  if (!Array.isArray(locations) || locations.length <= 1) {
    return false;
  }
  const locationDirs = getUniqueDirectories(locations);
  return locationDirs.size > 1;
}

function removeSingleLineComments(code: string): string {
  return code
    .split('\n')
    .map((line) => {
      const commentIndex = line.indexOf('//');
      return commentIndex === -1 ? line : line.slice(0, commentIndex);
    })
    .join('\n');
}

function removeMultiLineComments(code: string): string {
  let result = '';
  let i = 0;
  while (i < code.length) {
    if (code[i] === '/' && code[i + 1] === '*') {
      const endIndex = code.indexOf('*/', i + 2);
      if (endIndex === -1) {
        break;
      }
      i = endIndex + 2;
    } else {
      result += code[i];
      i++;
    }
  }
  return result;
}

function normalizeBody(body: string): string {
  let normalized = body;
  normalized = removeSingleLineComments(normalized);
  normalized = removeMultiLineComments(normalized);
  normalized = normalized.replaceAll(/\s+/g, ' ');
  normalized = normalized.trim();
  return normalized;
}

function hashBody(body: string): string {
  const normalized = normalizeBody(body);
  return createHash('sha256').update(normalized).digest('hex');
}

function isUtilityFunction(name: string, domainSpecific: ReadonlySet<string>): boolean {
  if (domainSpecific.has(name)) {
    return false;
  }
  return UTILITY_PATTERNS.some((pattern) => pattern.test(name));
}

function extractUtilityFunctionsWithBody(
  filePath: string,
  content: string,
  domainSpecific: ReadonlySet<string>,
): FunctionInfo[] {
  const functions: FunctionInfo[] = [];

  try {
    const sourceFile = getSharedSourceFile(filePath, content);
    if (!sourceFile) return [];

    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        const name = node.name.text;
        if (isUtilityFunction(name, domainSpecific)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          const body = node.body.getText(sourceFile);
          functions.push({
            name,
            line: line + 1,
            file: filePath,
            bodyHash: hashBody(body),
            bodyLength: body.length,
          });
        }
      }

      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isArrowFunction(node.initializer)
      ) {
        const name = node.name.text;
        if (isUtilityFunction(name, domainSpecific)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          const body = node.initializer.body.getText(sourceFile);
          functions.push({
            name,
            line: line + 1,
            file: filePath,
            bodyHash: hashBody(body),
            bodyLength: body.length,
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  } catch {
    // @swallow-ok Ignore parse errors
  }

  return functions;
}

function createIdenticalViolation(name: string, locations: FunctionInfo[]): CheckViolation {
  const first = locations[0];
  if (!first) {
    throw new Error(`createIdenticalViolation called with empty locations array for '${name}'`);
  }
  const otherFilesStr = formatOtherFiles(locations);

  return {
    line: first.line,
    message: `Utility function '${name}' has identical implementation in ${locations.length} locations`,
    severity: 'warning',
    suggestion: `Move '${name}' to packages/shared/backend/foundation/utils/ or a relevant domain utils module. Also in: ${otherFilesStr}`,
    type: 'duplicate-utility-identical',
    match: name,
    filePath: first.file,
  };
}

function createSimilarViolation(name: string, uniqueImpls: FunctionInfo[]): CheckViolation {
  const first = uniqueImpls[0];
  if (!first) {
    throw new Error(`createSimilarViolation called with empty uniqueImpls array for '${name}'`);
  }
  const otherFilesStr = formatOtherFiles(uniqueImpls);
  const numImplementations = uniqueImpls.length;

  return {
    line: first.line,
    message: `Utility function '${name}' has ${numImplementations} different implementations - consider consolidation with options`,
    severity: 'warning',
    suggestion: `Create a unified '${name}' function with configurable options in packages/shared/backend/foundation/utils/. Different implementations found in: ${otherFilesStr}`,
    type: 'duplicate-utility-similar',
    match: name,
    filePath: first.file,
  };
}

export async function collectFunctionsFromFiles(
  files: FileAccessor,
  domainSpecific: ReadonlySet<string>,
): Promise<FunctionsByName> {
  const functionsByName: FunctionsByName = new Map();

  for (const filePath of files.paths) {
    try {
      // @fitness-ignore-next-line performance-anti-patterns -- sequential file reading to control memory; FileAccessor is lazy
      const content = await files.read(filePath);
      const functions = extractUtilityFunctionsWithBody(filePath, content, domainSpecific);
      const validFunctions = functions.filter((fn) => fn.bodyLength >= MIN_FUNCTION_BODY_LENGTH);

      for (const fn of validFunctions) {
        void addFunctionToCollection(functionsByName, fn);
      }
    } catch {
      // @swallow-ok Skip unreadable files
    }
  }

  return functionsByName;
}

function findIdenticalViolations(
  name: string,
  hashGroups: Map<string, FunctionInfo[]>,
): CheckViolation[] {
  const violations: CheckViolation[] = [];

  for (const locations of hashGroups.values()) {
    if (isValidCrossDirectoryDuplicate(locations)) {
      violations.push(createIdenticalViolation(name, locations));
    }
  }

  return violations;
}

function findSimilarViolation(
  name: string,
  hashGroups: Map<string, FunctionInfo[]>,
): CheckViolation | null {
  if (hashGroups.size <= 1) {
    return null;
  }

  const uniqueImpls = getFirstFromEachHashGroup(hashGroups);
  if (!Array.isArray(uniqueImpls) || uniqueImpls.length <= 1) {
    return null;
  }

  const implDirs = getUniqueDirectories(uniqueImpls);
  if (implDirs.size <= 1) {
    return null;
  }

  return createSimilarViolation(name, uniqueImpls);
}

export function processFunctionGroup(
  name: string,
  hashGroups: Map<string, FunctionInfo[]>,
): CheckViolation[] {
  const allLocations = flattenHashGroups(hashGroups);
  const dirs = getUniqueDirectories(allLocations);

  if (dirs.size <= 1 || hashGroups.size === 0) {
    return [];
  }

  const violations: CheckViolation[] = [...findIdenticalViolations(name, hashGroups)];

  const similarViolation = findSimilarViolation(name, hashGroups);
  if (similarViolation) {
    violations.push(similarViolation);
  }

  return violations;
}
