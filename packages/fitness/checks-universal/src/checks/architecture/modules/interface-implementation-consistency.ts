// @fitness-ignore-file interface-implementation-consistency -- Fitness check definition file; references interface patterns for detection, not actual implementations
/**
 * @fileoverview Interface Implementation Consistency check
 */

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-cli/fitness';

import {
  isAllowedExtraMethod,
  TEST_DOUBLE_CLASS_NAME_PATTERN,
} from './interface-implementation-consistency-constants.js';
import {
  createInterfaceMethodsResolver,
  mergeInterface,
  parseClasses,
  parseInterfaces,
  type ClassImplementation,
  type InterfaceDefinition,
} from './interface-implementation-consistency-parse.js';

interface ConsistencyIssue {
  file: string;
  line: number;
  type: 'extra-method' | 'missing-method';
  name: string;
  message: string;
  severity: 'error' | 'warning';
}

function checkConsistencyForClass(
  cls: ClassImplementation,
  getInterfaceMethods: (name: string) => string[],
  issues: ConsistencyIssue[],
): void {
  /* v8 ignore next */
  if (!Array.isArray(issues)) return;
  if (cls.implements.length === 0) return;
  if (TEST_DOUBLE_CLASS_NAME_PATTERN.test(cls.name)) return;

  const allowedMethods = new Set<string>();
  for (const ifaceName of cls.implements) {
    for (const method of getInterfaceMethods(ifaceName)) {
      allowedMethods.add(method);
    }
  }

  const reportInterface = cls.implements[0] ?? 'unknown';
  const extraMethods = cls.methods.filter(
    (method) => !isAllowedExtraMethod(method) && !allowedMethods.has(method),
  );

  for (const method of extraMethods) {
    issues.push({
      file: cls.file,
      line: cls.startLine,
      type: 'extra-method',
      name: `${cls.name}.${method}`,
      message: `Method '${method}()' in class '${cls.name}' is not declared in interface '${reportInterface}'`,
      severity: 'warning',
    });
  }
}

/**
 * Check: architecture/interface-implementation-consistency
 *
 * Verifies interfaces match their implementations:
 * - Detects methods in class not declared in interface
 * - Allows common utility methods (dispose, init, etc.)
 */
export const interfaceImplementationConsistency = defineCheck({
  id: 'c9549378-95bf-4b5f-923c-c342134c3068',
  slug: 'interface-implementation-consistency',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Verifies interfaces match their implementations',
  longDescription: `**Purpose:** Ensures classes that \`implements\` an interface do not expose public methods absent from that interface, keeping contracts honest.

**Detects:**
- Public methods in a class that are not declared in any of its implemented interfaces (parsed via regex patterns for \`interface\` and \`class ... implements\`)
- Resolves interface inheritance chains (\`extends\`) to collect the full set of allowed methods
- Skips private/protected methods, constructors, JS keywords, and a curated allowlist of common utility methods (e.g., \`dispose\`, \`init\`, \`toJSON\`, \`subscribe\`)

**Why it matters:** Undeclared public methods on implementing classes break the Interface Segregation Principle and make it harder to swap implementations.

**Scope:** Codebase-specific convention. Cross-file analysis via \`analyzeAll\` across packages and services.`,
  timeout: 120_000,
  tags: ['architecture', 'consistency'],
  fileTypes: ['ts'],

  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const allInterfaces = new Map<string, InterfaceDefinition>();
    const allClasses = new Map<string, ClassImplementation>();

    // @lazy-ok -- validations inside loop depend on file content from await
    for (const file of files.paths) {
      const content = await files.read(file);
      if (!content) continue;

      if (content.includes('interface ')) {
        for (const iface of parseInterfaces(content, file)) {
          void mergeInterface(allInterfaces, iface);
        }
      }

      if (content.includes('class ') && content.includes('implements ')) {
        for (const cls of parseClasses(content, file)) {
          allClasses.set(cls.name, cls);
        }
      }
    }

    const getInterfaceMethods = createInterfaceMethodsResolver(allInterfaces);
    const issues: ConsistencyIssue[] = [];

    allClasses.forEach((cls) => {
      checkConsistencyForClass(cls, getInterfaceMethods, issues);
    });

    return issues.map((issue) => ({
      filePath: issue.file,
      line: issue.line,
      message: issue.message,
      severity: issue.severity,
      suggestion: `Add method '${issue.name.split('.')[1]}()' to the interface, or remove it from the class if it's not part of the public API.`,
      match: issue.name,
      type: issue.type,
    }));
  },
});
