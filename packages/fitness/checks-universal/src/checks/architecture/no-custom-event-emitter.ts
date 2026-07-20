/**
 * @fileoverview No Custom Event Emitter check
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

import {
  createCodeMask,
  findCodeMatches,
  findStaticModuleReferences,
} from '../code-aware-match.js';

interface EventEmitterIssue {
  file: string;
  line: number;
  type: string;
  match: string;
  suggestion: string;
  severity: 'error' | 'warning';
}

const EVENT_EMITTER_PATTERNS = [
  {
    pattern: /new\s+(?:[\w$]+\s*\.\s*)?EventEmitter\s*\(/gi,
    type: 'new-event-emitter',
    suggestion: 'Use a centralized event bus instead of direct EventEmitter instantiation',
    severity: 'error' as const,
  },
  {
    pattern: /extends\s+(?:[\w$]+\s*\.\s*)?EventEmitter\b/gi,
    type: 'extends-event-emitter',
    suggestion:
      'Implement event handling via a centralized event bus instead of extending EventEmitter',
    severity: 'error' as const,
  },
];

const EVENT_INFRA_PATTERNS = [
  /infrastructure\/events\//,
  /foundation\//,
  /\/adapters\//,
  /interfaces\//,
];

function analyzeFile(filePath: string, content: string): EventEmitterIssue[] {
  const issues: EventEmitterIssue[] = [];

  if (EVENT_INFRA_PATTERNS.some((p) => p.test(filePath))) {
    return [];
  }

  const codeMask = createCodeMask(filePath, content);
  for (const { pattern, type, suggestion, severity } of EVENT_EMITTER_PATTERNS) {
    for (const match of findCodeMatches(pattern, codeMask, codeMask)) {
      issues.push({
        file: filePath,
        line: content.slice(0, match.index).split('\n').length,
        type,
        match: content.slice(match.index, match.index + match[0].length),
        suggestion,
        severity,
      });
    }
  }

  const importsEventEmitter = findStaticModuleReferences(filePath, content).filter(
    (reference) =>
      reference.keyword === 'import' &&
      reference.runtimeImport &&
      (reference.moduleSpecifier === 'events' || reference.moduleSpecifier === 'node:events') &&
      reference.runtimeBindingNames.includes('EventEmitter'),
  );
  for (const reference of importsEventEmitter) {
    issues.push({
      file: filePath,
      line: content.slice(0, reference.index).split('\n').length,
      type: 'import-event-emitter',
      match: 'EventEmitter',
      suggestion: 'Use a centralized event bus instead of importing EventEmitter directly',
      severity: 'error',
    });
  }

  return issues;
}

/**
 * Check: architecture/no-custom-event-emitter
 *
 * Detects direct EventEmitter usage that should use infrastructure/events module.
 * Ensures consistent event handling patterns across the codebase.
 */
export const noCustomEventEmitter = defineCheck({
  id: '7a36c3b8-fb23-42fc-8f25-336e012aab57',
  slug: 'no-custom-event-emitter',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Detects direct EventEmitter usage that should use infrastructure/events',
  longDescription: `**Purpose:** Prevents direct usage of Node.js \`EventEmitter\` in favor of a centralized event bus.

**Detects:**
- Direct instantiation of Node.js event emitter
- Class inheritance from Node.js event emitter
- Imports of Node.js event emitter from 'events' or 'node:events'
- Excludes \`infrastructure/events/\`, \`foundation/\`, \`/adapters/\`, and \`interfaces/\` directories

**Why it matters:** Custom event emitters bypass centralized event bus patterns, making event flows untraceable and inconsistent across the platform.

**Scope:** Codebase-specific convention. Analyzes each file individually.`,
  tags: ['architecture', 'best-practices'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    // Skip if no EventEmitter usage
    if (!content.includes('EventEmitter')) {
      return [];
    }

    const issues = analyzeFile(filePath, content);

    return issues.map((issue) => ({
      line: issue.line,
      message: `Custom event emitter: ${issue.type}. ${issue.suggestion}`,
      severity: issue.severity,
      suggestion: issue.suggestion,
      match: issue.match,
      type: issue.type,
    }));
  },
});
