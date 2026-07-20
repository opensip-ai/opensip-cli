/**
 * @fileoverview Heavy import detection
 * @module checks-builtin/checks/architecture/heavy-import-detection
 *
 * Detects imports that unnecessarily bloat bundle size:
 * - Full/namespace imports of tree-shakeable libraries (import * as _ from 'lodash')
 * - Deprecated library usage (moment -> date-fns/dayjs, aws-sdk v2 -> v3)
 * - Excessive named imports from a single module (>15 items)
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

import { findStaticModuleReferences, type StaticModuleReference } from '../code-aware-match.js';

interface HeavyLibrary {
  moduleSpecifier: string;
  message: string;
  suggestion: string;
  deprecated?: boolean;
  namespaceOnly?: boolean;
}

const HEAVY_LIBRARIES: HeavyLibrary[] = [
  {
    moduleSpecifier: 'lodash',
    message: 'Namespace import of lodash pulls in the entire library (~70KB)',
    suggestion:
      "Use named imports: import { debounce } from 'lodash' or import debounce from 'lodash/debounce'",
    namespaceOnly: true,
  },
  {
    moduleSpecifier: 'moment',
    message: 'moment.js is deprecated and heavy (~300KB). Use date-fns or dayjs instead',
    suggestion: "Replace with: import { format } from 'date-fns' or import dayjs from 'dayjs'",
    deprecated: true,
  },
  {
    moduleSpecifier: 'aws-sdk',
    message: 'aws-sdk v2 is deprecated and heavy. Use modular v3 packages',
    suggestion: "Replace with modular import: import { S3Client } from '@aws-sdk/client-s3'",
    deprecated: true,
  },
  {
    moduleSpecifier: 'rxjs',
    message: 'Namespace import of rxjs pulls in the entire library. Use specific imports',
    suggestion:
      "Use: import { Observable, map } from 'rxjs' or import { map } from 'rxjs/operators'",
    namespaceOnly: true,
  },
];

const EXCESSIVE_NAMED_IMPORT_THRESHOLD = 15;

function matchesHeavyLibrary(reference: StaticModuleReference, library: HeavyLibrary): boolean {
  if (!reference.runtimeImport) return false;
  if (library.namespaceOnly === true) {
    return reference.namespaceImport;
  }
  // Deprecated modules are a problem for every runtime import, including a
  // side-effect-only declaration.
  return library.deprecated === true;
}

function importSourceLine(content: string, reference: StaticModuleReference): string {
  const lineEnd = content.indexOf('\n', reference.index);
  return content.slice(reference.index, lineEnd === -1 ? content.length : lineEnd).trim();
}

function heavyLibraryViolations(
  content: string,
  filePath: string,
  reference: StaticModuleReference,
): CheckViolation[] {
  const line = content.slice(0, reference.index).split('\n').length;
  return HEAVY_LIBRARIES.filter(
    (library) =>
      reference.moduleSpecifier === library.moduleSpecifier &&
      matchesHeavyLibrary(reference, library),
  ).map((library) => ({
    line,
    message: library.message,
    severity: library.deprecated ? 'error' : 'warning',
    suggestion: library.suggestion,
    type: library.deprecated ? 'DEPRECATED_LIBRARY' : 'HEAVY_IMPORT',
    match: importSourceLine(content, reference),
    filePath,
  }));
}

function excessiveNamedImportViolation(
  content: string,
  filePath: string,
  reference: StaticModuleReference,
): CheckViolation | null {
  const count = reference.runtimeNamedBindingCount;
  if (count <= EXCESSIVE_NAMED_IMPORT_THRESHOLD) return null;
  return {
    line: content.slice(0, reference.index).split('\n').length,
    message: `Excessive named imports: ${count} items from '${reference.moduleSpecifier}'. Consider splitting into multiple import groups.`,
    severity: 'warning',
    suggestion: 'Split into multiple focused imports or evaluate if all imports are needed.',
    type: 'EXCESSIVE_NAMED_IMPORTS',
    match: `${count} imports from ${reference.moduleSpecifier}`,
    filePath,
  };
}

export const heavyImportDetection = defineCheck({
  id: 'ebd495d1-ae48-478d-a1cc-4823a18cada6',
  slug: 'heavy-import-detection',
  contentFilter: 'raw',
  scope: {
    languages: ['typescript', 'javascript'],
    concerns: ['backend', 'frontend'],
  },
  confidence: 'high',
  description:
    'Detects heavy/deprecated library imports and excessive named imports that bloat bundle size',
  tags: ['architecture', 'performance', 'bundle-size'],
  fileTypes: ['ts', 'tsx', 'js', 'jsx'],

  analyze(content: string, filePath: string): CheckViolation[] {
    if (filePath.includes('.test.') || filePath.includes('__tests__')) return [];

    const imports = findStaticModuleReferences(filePath, content).filter(
      (reference) => reference.keyword === 'import',
    );
    return imports.flatMap((reference) => {
      const violations = heavyLibraryViolations(content, filePath, reference);
      const excessive = excessiveNamedImportViolation(content, filePath, reference);
      return excessive ? [...violations, excessive] : violations;
    });
  },
});
