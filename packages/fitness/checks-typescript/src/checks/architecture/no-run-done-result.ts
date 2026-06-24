/**
 * @fileoverview Run commands render via RunPresentation — no per-tool `*DoneResult`.
 *
 * The envelope-first-presentation plan (ADR-0011) collapsed the three
 * near-identical per-tool run-result interfaces (one each for fit/sim/graph) into
 * a single render-only `RunPresentation` (`type: 'run-presentation'`) on the
 * `CommandResult` union. Each of those interfaces only wrapped a `SignalEnvelope`
 * plus render-only adjuncts, so the union grew one variant per tool and
 * `resultToView` carried one near-duplicate render case per tool. They were
 * hard-removed in RP-3.
 *
 * This check guards the `@opensip-cli/contracts` command-result surface against a
 * regression: re-declaring a per-tool run done-result interface/type (a name
 * ending `…DoneResult` for fit/sim/graph) OR a discriminator property
 * `type: 'fit-done' | 'sim-done' | 'graph-done'`. Run commands must render through
 * the one `RunPresentation` variant.
 *
 * Path-gated to `packages/contracts/src/` (the contract surface) and test-exempt.
 * AST-based so a `*-done` string appearing as TEXT (a comment, a doc example, an
 * unrelated string) is not flagged — only a real type/interface declaration or a
 * `type:` discriminator literal in a type declaration counts.
 */
// @fitness-ignore-file shipped-checks-must-be-generic -- opensip-internal dogfood guard for the envelope-first-presentation contract surface; AST precision keeps it from flagging the `*-done` literals that legitimately appear in prose. Needs @opensip-cli/lang-typescript, which a project-local .mjs cannot import.
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

/** The contract surface this check guards. */
const CONTRACTS_SRC_PATH = 'packages/contracts/src/';

/** A re-introduced per-tool run done-result type name (fit/sim/graph). */
const DONE_RESULT_NAME_RE = /^(?:Fit|Sim|Graph)DoneResult$/;

/** A re-introduced per-tool run done-result discriminator literal. */
const DONE_RESULT_DISCRIMINATOR: ReadonlySet<string> = new Set([
  'fit-done',
  'sim-done',
  'graph-done',
]);

const GUIDANCE =
  'Run commands render via the single RunPresentation variant (ADR-0011 / ' +
  'envelope-first-presentation plan); do not re-introduce per-tool *DoneResult types.';

function normalized(path: string): string {
  return path.replaceAll('\\', '/');
}

/** A `type:` property whose value is a `fit-done|sim-done|graph-done` string literal. */
function isDoneDiscriminatorMember(member: ts.TypeElement): boolean {
  if (!ts.isPropertySignature(member) || member.type === undefined) return false;
  if (!ts.isIdentifier(member.name) || member.name.text !== 'type') return false;
  if (!ts.isLiteralTypeNode(member.type) || !ts.isStringLiteral(member.type.literal)) {
    return false;
  }
  return DONE_RESULT_DISCRIMINATOR.has(member.type.literal.text);
}

/** Walk a type node's members (interface body or type-literal) for a done discriminator. */
function membersOf(node: ts.Node): readonly ts.TypeElement[] | undefined {
  if (ts.isInterfaceDeclaration(node)) return node.members;
  if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) return node.type.members;
  return undefined;
}

/** Pure analysis over a parsed source file. Exported for unit tests. */
export function analyzeNoRunDoneResult(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const sourceFile = getSharedSourceFile(filePath, content);
  if (!sourceFile) return violations;

  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text;
      if (DONE_RESULT_NAME_RE.test(name)) {
        violations.push({
          filePath,
          line: lineOf(node),
          message: `Type '${name}' re-introduces a per-tool run done-result. ${GUIDANCE}`,
          severity: 'error',
          suggestion: 'Render the run via the RunPresentation variant on CommandResult.',
        });
      } else {
        const members = membersOf(node);
        if (members?.some(isDoneDiscriminatorMember)) {
          violations.push({
            filePath,
            line: lineOf(node),
            message: `Type '${name}' declares a per-tool run done-result discriminator. ${GUIDANCE}`,
            severity: 'error',
            suggestion: "Use the shared `type: 'run-presentation'` run variant instead.",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

export const noRunDoneResult = defineCheck({
  id: 'a3d9f1c4-7b2e-4f6a-9c1d-8e5b0a2f4d63',
  slug: 'architecture-no-run-done-result',
  contentFilter: 'raw',
  description:
    'Run commands render via the single RunPresentation variant; the contracts surface must not re-introduce a per-tool *DoneResult run type',
  longDescription: `**Purpose:** Guard the \`@opensip-cli/contracts\` command-result surface against re-growing one run-result interface per tool.

**Detects (in \`packages/contracts/src/\` only):**
- A re-declared per-tool run done-result type/interface (name ending \`…DoneResult\` for fit/sim/graph).
- A discriminator property \`type: 'fit-done' | 'sim-done' | 'graph-done'\` on a type/interface declaration.

**Why it matters:** The envelope-first-presentation plan (ADR-0011) collapsed the three per-tool run results into one render-only \`RunPresentation\`. Re-introducing a per-tool done-result would re-grow the union and \`resultToView\` and diverge the human render from the envelope verdict.

**Scope:** Contracts package source only; test files exempt.`,
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture', 'contracts'],
  fileTypes: ['ts'],
  analyze: (content, filePath) => {
    if (!normalized(filePath).includes(CONTRACTS_SRC_PATH) || isTestFile(filePath)) return [];
    return analyzeNoRunDoneResult(content, filePath);
  },
});
