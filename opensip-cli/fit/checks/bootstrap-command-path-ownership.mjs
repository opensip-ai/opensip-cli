/**
 * @fileoverview bootstrap-command-path-ownership — owning-tool resolution must
 * use the full command path so shared nested leaves (`list`, `export`,
 * `recipes`) cannot initialize or load capabilities for the wrong tool.
 */
import { defineCheck } from '@opensip-cli/fitness';

const TARGET = 'packages/cli/src/bootstrap/execute-post-bailout-bootstrap.ts';

function normalized(filePath) {
  return filePath.replaceAll('\\', '/');
}

function lineOf(content, needle) {
  const index = content.indexOf(needle);
  if (index < 0) return 1;
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

export function analyzeBootstrapCommandPathOwnership(content, filePath) {
  if (!normalized(filePath).endsWith(TARGET)) return [];

  const violations = [];
  for (const needle of [
    'resolveOwningTool(tools, plan.commandName',
    'maybeInitializeOwningTool(tools, plan.commandName',
  ]) {
    if (!content.includes(needle)) continue;
    violations.push({
      message:
        'Owning-tool bootstrap must resolve from plan.commandPath, not the leaf commandName.',
      severity: 'error',
      line: lineOf(content, needle),
      suggestion:
        'Pass plan.commandPath so nested commands like graph list are owned by graph instead of the first tool with a list leaf.',
    });
  }

  return violations;
}

export const checks = [
  defineCheck({
    id: '81a76b4d-049e-4144-83a4-4415fdb9bfda',
    slug: 'bootstrap-command-path-ownership',
    description: 'Bootstrap owning-tool resolution uses full command paths, not shared leaves',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture'],
    fileTypes: ['ts'],
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeBootstrapCommandPathOwnership(content, filePath),
  }),
];
