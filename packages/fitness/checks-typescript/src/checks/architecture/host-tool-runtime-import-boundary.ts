/**
 * @fileoverview Mechanize the ADR-0054 M4-G CAPSTONE invariant: no
 * `importToolRuntime(...)` for external-provenance tools in the HOST process.
 *
 * After the capstone, external tool runtime code NEVER loads in the host. The
 * host registers a manifest-derived synthetic Tool (command shells from the
 * static manifest) and mounts its commands without importing the runtime; the
 * forked dispatch WORKER imports the untrusted runtime when a command actually
 * dispatches. This is no longer a transition guardrail — it is the enforced
 * boundary. The check asserts three things across the CLI host package:
 *
 *   1. `importToolRuntime` may be called only from the admission/discovery
 *      boundary or the worker-owned dispatch plane (the allowlisted files).
 *      Any other host-process call site is a violation.
 *   2. A HOST import must pass a BUNDLED policy — `hostRuntimeImportPolicyFor(...)`
 *      (type-narrowed to `'bundled'`) or a literal `{ source: 'bundled' }`. A
 *      non-bundled host policy is a violation (the type already forbids it; this
 *      catches a hand-rolled literal that bypasses the constructor).
 *   3. `workerRuntimeImportPolicyFor(...)` — the policy that authorizes loading an
 *      EXTERNAL runtime — is permitted only on the worker-owned plane (the
 *      discovery leg gated behind `isHostRuntimeImportForbidden`, the worker entry,
 *      and the admission module that defines it). Using it elsewhere would import
 *      an external runtime in the host.
 *
 * The `adr0054Transition` exception is gone: the worker is now the only path for
 * external runtime import, and the host import policy is bundled-only.
 */
// @fitness-ignore-file shipped-checks-must-be-generic -- dogfood check for this repo's ADR-0054 capstone boundary; AST precision keeps the host/worker import distinction mechanically exact.
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

const CLI_HOST_PATH = 'packages/cli/src/';
const IMPORT_RUNTIME = 'importToolRuntime';
const HOST_POLICY_HELPER = 'hostRuntimeImportPolicyFor';
const WORKER_POLICY_HELPER = 'workerRuntimeImportPolicyFor';

/**
 * The files permitted to call `importToolRuntime` at all (admission/discovery +
 * the worker-owned dispatch plane). Any other host file is a hard violation.
 */
const ALLOWED_CALLSITE_SUFFIXES = new Set([
  'packages/cli/src/bootstrap/admit-tool-package.ts',
  'packages/cli/src/bootstrap/register-tools.ts',
  'packages/cli/src/bootstrap/register-tools-discovery.ts',
  // Authored (project-local / user-global) tool registration: same host-vs-worker
  // discovery split as register-tools-discovery (the import runs only in the
  // worker, gated by isHostRuntimeImportForbidden).
  'packages/cli/src/bootstrap/register-authored-tools.ts',
  // ADR-0054 worker-owned dispatch plane: this entry runs in the FORKED worker
  // process (not the host), so importing the external runtime here is the
  // isolation goal. It uses the worker policy.
  'packages/cli/src/bootstrap/tool-command-worker-entry.ts',
]);

/**
 * The files permitted to construct/pass the WORKER policy
 * (`workerRuntimeImportPolicyFor`) — the policy that authorizes loading an
 * EXTERNAL runtime. This is the worker-owned plane: the discovery leg (which
 * gates the import behind `isHostRuntimeImportForbidden`, so it runs only inside
 * the worker), the worker entry, and the admission module that defines the
 * constructor + runs the bundled/probe runtime-load section. Using the worker
 * policy anywhere else would import an external runtime in the host.
 */
const ALLOWED_WORKER_POLICY_SUFFIXES = new Set([
  'packages/cli/src/bootstrap/admit-tool-package.ts',
  'packages/cli/src/bootstrap/register-tools-discovery.ts',
  'packages/cli/src/bootstrap/register-authored-tools.ts',
  'packages/cli/src/bootstrap/tool-command-worker-entry.ts',
]);

function normalized(path: string): string {
  return path.replaceAll('\\', '/');
}

function endsWithAny(filePath: string, suffixes: ReadonlySet<string>): boolean {
  const p = normalized(filePath);
  for (const suffix of suffixes) {
    if (p.endsWith(suffix)) return true;
  }
  return false;
}

function isAllowedCallsite(filePath: string): boolean {
  return endsWithAny(filePath, ALLOWED_CALLSITE_SUFFIXES);
}

function isWorkerPolicyAllowed(filePath: string): boolean {
  return endsWithAny(filePath, ALLOWED_WORKER_POLICY_SUFFIXES);
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

/** The kind of policy a runtime-import argument expresses (capstone discrimination). */
type PolicyKind = 'host-bundled' | 'worker' | 'other';

/** A call to a named policy helper, e.g. `hostRuntimeImportPolicyFor(source)`. */
function helperCallName(arg: ts.Expression): string | undefined {
  if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)) return arg.expression.text;
  return undefined;
}

/** Whether an object literal is exactly `{ source: 'bundled' }` (the host policy). */
function isBundledLiteral(arg: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(arg)) return false;
  let bundled = false;
  for (const prop of arg.properties) {
    if (!ts.isPropertyAssignment(prop)) return false;
    const name = propertyNameText(prop.name);
    if (name !== 'source') return false;
    if (!ts.isStringLiteral(prop.initializer) || prop.initializer.text !== 'bundled') return false;
    bundled = true;
  }
  return bundled;
}

/** Classify the policy argument of an `importToolRuntime(dir, policy)` call. */
function classifyPolicyArg(arg: ts.Expression | undefined): PolicyKind {
  if (arg === undefined) return 'other';
  const helper = helperCallName(arg);
  if (helper === HOST_POLICY_HELPER) return 'host-bundled';
  if (helper === WORKER_POLICY_HELPER) return 'worker';
  if (isBundledLiteral(arg)) return 'host-bundled';
  return 'other';
}

function localRuntimeImportNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const module = stmt.moduleSpecifier.text;
    if (!module.endsWith('/admit-tool-package.js') && module !== './admit-tool-package.js') {
      continue;
    }
    const named = stmt.importClause?.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (imported === IMPORT_RUNTIME) names.add(element.name.text);
    }
  }
  // The defining module calls its own exported function by name.
  if (isAllowedCallsite(sourceFile.fileName)) names.add(IMPORT_RUNTIME);
  return names;
}

/** Pure analysis over a parsed source file. Exported for unit tests. */
export function analyzeHostToolRuntimeImportBoundary(
  content: string,
  filePath: string,
): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const sourceFile = getSharedSourceFile(filePath, content);
  if (!sourceFile) return violations;

  const runtimeNames = localRuntimeImportNames(sourceFile);
  if (runtimeNames.size === 0) return violations;

  const allowedFile = isAllowedCallsite(filePath);
  const workerPolicyAllowed = isWorkerPolicyAllowed(filePath);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      if (runtimeNames.has(callee)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        const kind = classifyPolicyArg(node.arguments[1]);
        if (!allowedFile) {
          violations.push({
            message:
              `importToolRuntime may only be called from the tool admission/discovery boundary ` +
              `or the worker-owned dispatch plane (ADR-0054 M4-G capstone). Found host-process ` +
              `runtime import in ${normalized(filePath)}.`,
            severity: 'error',
            line,
            suggestion:
              'External tool runtimes load ONLY behind the worker boundary. Register a ' +
              'manifest-derived synthetic Tool in the host; import the runtime in the worker.',
          });
        } else if (kind === 'other') {
          violations.push({
            message:
              'importToolRuntime must pass an explicit policy — a bundled HOST policy ' +
              "(hostRuntimeImportPolicyFor or { source: 'bundled' }) or workerRuntimeImportPolicyFor " +
              'on the worker-owned plane (ADR-0054 M4-G).',
            severity: 'error',
            line,
            suggestion:
              'Pass hostRuntimeImportPolicyFor(...) for a bundled host import, or ' +
              'workerRuntimeImportPolicyFor(source) on the worker plane.',
          });
        } else if (kind === 'worker' && !workerPolicyAllowed) {
          violations.push({
            message:
              `workerRuntimeImportPolicyFor authorizes loading an EXTERNAL tool runtime; it is ` +
              `permitted only on the worker-owned dispatch plane, not in ${normalized(filePath)} ` +
              `(ADR-0054 M4-G capstone: external runtimes never import in the host).`,
            severity: 'error',
            line,
            suggestion:
              'In the host, register a manifest-derived synthetic Tool instead. Import the ' +
              'external runtime only in the dispatch worker.',
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

export const hostToolRuntimeImportBoundary = defineCheck({
  id: 'b7554963-e24e-4d80-b3e0-edbb97bbdba3',
  slug: 'host-tool-runtime-import-boundary',
  description:
    'External tool runtimes never import in the host: importToolRuntime stays in the admission/discovery boundary, host imports are bundled-only, and the external worker policy is confined to the worker plane (ADR-0054 M4-G capstone)',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture'],
  fileTypes: ['ts', 'tsx'],
  analyze: (content, filePath) => {
    if (!normalized(filePath).includes(CLI_HOST_PATH) || isTestFile(filePath)) return [];
    return analyzeHostToolRuntimeImportBoundary(content, filePath);
  },
});
