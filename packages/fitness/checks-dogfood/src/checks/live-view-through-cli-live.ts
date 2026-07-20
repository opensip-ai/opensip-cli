/**
 * ADR-0058: tool live views must route through @opensip-cli/cli-live — never
 * import ink's `render` or hand-roll live chrome in tool engine packages.
 */
// @fitness-ignore-file shipped-checks-must-be-generic -- opensip-internal dogfood guard for the shared live-run shell; path-gated to first-party tool engines.
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

const TOOL_ENGINE_PATH =
  /packages\/(fitness\/engine|graph\/engine|simulation\/engine|yagni\/engine)\/src\//;

const GUIDANCE =
  'Tool live views must route through runToolLiveView (@opensip-cli/cli-live); do not import ink render in tool engines (ADR-0058).';

function isTypeOnlyImport(clause: ts.ImportClause | undefined): boolean {
  // sonarjs/deprecation false positive: the ImportClause.isTypeOnly PROPERTY is not deprecated.
  // eslint-disable-next-line sonarjs/deprecation -- TypeScript's createImportClause parameter, not this property, is deprecated
  return clause?.isTypeOnly === true;
}

export function analyzeLiveViewThroughCliLive(content: string, filePath: string): CheckViolation[] {
  const normalized = filePath.replaceAll('\\', '/');
  if (!TOOL_ENGINE_PATH.test(normalized) || isTestFile(filePath)) return [];
  const sourceFile = getSharedSourceFile(filePath, content);
  if (!sourceFile) return [];
  const renderImport = sourceFile.statements
    .filter(
      (stmt): stmt is ts.ImportDeclaration =>
        ts.isImportDeclaration(stmt) &&
        ts.isStringLiteral(stmt.moduleSpecifier) &&
        stmt.moduleSpecifier.text === 'ink' &&
        !isTypeOnlyImport(stmt.importClause),
    )
    .flatMap((stmt) => {
      const bindings = stmt.importClause?.namedBindings;
      return bindings !== undefined && ts.isNamedImports(bindings) ? [...bindings.elements] : [];
    })
    .find(
      (element) => !element.isTypeOnly && (element.propertyName ?? element.name).text === 'render',
    );
  if (renderImport === undefined) return [];
  return [
    {
      filePath,
      line: sourceFile.getLineAndCharacterOfPosition(renderImport.getStart(sourceFile)).line + 1,
      message: `Direct ink render import in a tool engine. ${GUIDANCE}`,
      severity: 'error',
      suggestion: 'Use runToolLiveView from @opensip-cli/cli-live instead of ink render.',
    },
  ];
}

export const liveViewThroughCliLive = defineCheck({
  id: 'f8c2a1d0-4e5b-4a9c-8d7e-6f3b2a1c0d94',
  slug: 'live-view-through-cli-live',
  // Must keep string interiors: the import regex matches the module specifier
  // literal `'ink'`. strip-strings blanks that to `'   '` and would silence every
  // real violation while unit tests that call analyze with raw content still pass.
  contentFilter: 'raw',
  description: 'Tool engine live views route through cli-live (no direct ink render imports)',
  longDescription: `**Purpose:** Prevent tool engines from hand-rolling Ink live views.

**Detects:** A direct \`import { render } from 'ink'\` in fitness/graph/simulation/yagni engine source.

**Why it matters:** ADR-0058 centralizes live-run chrome in cli-ui + cli-live so fit/graph/sim/yagni cannot diverge again.

**Scope:** First-party tool engine packages only; test files exempt.`,
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture'],
  fileTypes: ['ts', 'tsx'],
  analyze: (content, filePath) => analyzeLiveViewThroughCliLive(content, filePath),
});
