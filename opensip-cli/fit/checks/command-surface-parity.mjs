/**
 * @fileoverview command-surface-parity — every command resolves to a typed
 *               CommandSpec; no raw Commander access from a tool (release 2.11.0
 *               command plane, north-star Principle 6). Project-local SELF-check.
 *
 * Relocated out of `@opensip-cli/checks-*` because it encodes opensip-cli local
 * facts: it hardcodes opensip-cli' OWN first-party TOOL registration paths
 * (`packages/{fitness,graph,simulation}/engine/src/tool.ts`), mirrors the host
 * allow-list `HOST_SUBCOMMAND_GROUPS` from
 * `packages/cli/src/commands/host-subcommand-groups.ts`, and guards the exact
 * `ToolCliContext.program` / `commandSpecs` / `mountCommandSpec` seams of THIS
 * platform's command plane. A consumer repo has none of those facts, and its own
 * CLI legitimately uses Commander — so the rule is opensip-internal, not
 * universal. Inert for adopters per `opensip-cli/fit/checks/README.md`.
 *
 * WHY: The 2.11.0 command plane removed the two-tier privilege where tools touched
 * Commander directly via `ToolCliContext.program: unknown`. Tools now DECLARE a
 * `commandSpecs` surface and the host mounts each spec via `mountCommandSpec`;
 * no tool has a `register()` body anymore. This check is the GUARDRAIL that makes
 * that privilege-removal stick: it fires when a tool registration file reaches
 * back into raw Commander (a `cli.program as ...` cast, or a
 * `program.command(`/`.option(`/`.argument(`/`.requiredOption(` call), or when a
 * `Tool` reintroduces a `register()` body while declaring no `commandSpecs`.
 * Without it, a future tool could quietly cast `cli.program` again and re-open
 * the escape the release just closed.
 *
 * Positive parity — that each tool actually DECLARES a `commandSpecs` surface and
 * that the mounted command tree matches 2.10.0 — is pinned by the behaviour-
 * parity snapshot test (`command-surface-parity.snapshot.test.ts` in `cli`). This
 * check is the complementary "don't reach back to raw Commander" guard.
 *
 * ALLOW-LIST — the host owns exactly three action-less Commander subcommand GROUP
 * parents (`sessions`, `plugin`, `tools`) that legitimately stay raw
 * `program.command(name)` shells because a parent with no action body is not a
 * single mountable `CommandSpec` (their LEAVES are specs). That allow-list lives
 * in `packages/cli/src/commands/host-subcommand-groups.ts`
 * (`HOST_SUBCOMMAND_GROUPS`); the value mirrored here is exactly those three.
 *
 * SCOPE — opensip-cli' own first-party TOOL registration files only
 * (`packages/{fitness,graph,simulation}/engine/src/tool.ts`). The path guard makes
 * it inert in adopter repos (whose own CLIs legitimately use Commander) — it
 * enforces THIS platform's architecture, not a universal rule. The two host
 * GROUP parents live under `packages/cli/...`, OUTSIDE this scope, so they never
 * trip the check; the allow-list is documented here for the reviewer and asserted
 * by the test.
 *
 * `raw` content: the patterns we detect (`.option(`, `cli.program as`) are code
 * tokens, and the path guard already restricts us to tool.ts files, so prose
 * cannot false-fire. Stripping comments is unnecessary and would hide a
 * commented-out re-acquisition of the program.
 */
import { defineCheck } from '@opensip-cli/fitness';

/** Resolved-path fragment identifying a first-party TOOL registration file. */
const TOOL_REGISTRATION_PATH = /packages\/(?:fitness|graph|simulation)\/engine\/src\/tool\.ts$/;

/**
 * The documented host-command exceptions — the action-less Commander subcommand
 * GROUP parents that are NOT single CommandSpecs (their leaves are). This MUST
 * equal `HOST_SUBCOMMAND_GROUPS` in
 * `packages/cli/src/commands/host-subcommand-groups.ts`. They live under
 * `packages/cli/...`, outside this check's tool-file scope, so they are never
 * inspected — the list is the finite, named justification a reviewer can audit,
 * and the test asserts it stays exactly these three.
 */
export const HOST_SUBCOMMAND_GROUP_EXCEPTIONS = ['sessions', 'plugin', 'tools'];

/**
 * Raw-Commander access patterns a tool file must never contain. Each entry is a
 * line-level regex plus the message/suggestion fired when it matches. The
 * `cli.program as` cast is the headline escape (re-acquiring the typed program);
 * the `program.command(`/`.option(`/`.argument(`/`.requiredOption(` calls are the
 * downstream uses that a cast enables.
 */
const RAW_COMMANDER_PATTERNS = [
  // `const program = cli.program as CliProgram` — re-acquiring the typed program
  // off the context. This is the one the 2.11.0 command plane removed.
  {
    re: /\bcli\.program\s+as\b/,
    label: 'a `cli.program as` cast (re-acquiring the raw Commander program)',
  },
  { re: /\bprogram\.command\(/, label: 'a raw `program.command(...)` call' },
  { re: /\.requiredOption\(/, label: 'a raw `.requiredOption(...)` call' },
  { re: /\.option\(/, label: 'a raw `.option(...)` call' },
  { re: /\.argument\(/, label: 'a raw `.argument(...)` call' },
];

/**
 * Matches a `register` mount-hook DECLARATION — either the method/call form
 * (`register(`, possibly preceded by a TS modifier the `\s*` skips) or the
 * property form (`register:` / `register =`, optionally `register?:`). Each
 * branch is anchored on a single literal token after the optional whitespace, so
 * the pattern is linear (no nested quantifier that could backtrack).
 */
const REGISTER_BODY_RE = /\bregister\s*[(?:=]/;

/** Detects a declared `commandSpecs` surface anywhere in the file. */
const COMMAND_SPECS_RE = /\bcommandSpecs\b/;

/**
 * Pure analysis function. Exported so unit tests can exercise detection without
 * the full Check framework. Flags (1) each line containing a raw-Commander
 * pattern, and (2) a `register()` body in a file that declares no `commandSpecs`.
 */
export function analyzeCommandSurfaceParity(content) {
  const violations = [];
  const lines = content.split('\n');

  for (const [i, line] of lines.entries()) {
    for (const pattern of RAW_COMMANDER_PATTERNS) {
      if (!pattern.re.test(line)) continue;
      violations.push({
        message: `Tool registration file reaches back to raw Commander via ${pattern.label}; every command must be a declared CommandSpec mounted by the host (release 2.11.0 command plane).`,
        severity: 'error',
        line: i + 1,
        suggestion:
          'Declare the command as a CommandSpec (defineCommand) on the tool’s `commandSpecs` and let `mountCommandSpec` wire Commander. Tools must not touch the program.',
      });
      // One finding per line is enough — a `.option(` line need not also report
      // the `program.command(` substring it may contain.
      break;
    }
  }

  // A `register()` body with no `commandSpecs` declaration = the deprecated mount
  // hook reintroduced. (A file that has BOTH is a tolerated transitional shape;
  // a file with neither — prose mentioning `register` — is also fine.)
  const hasRegisterBody = lines.some((line) => REGISTER_BODY_RE.test(line));
  const declaresCommandSpecs = COMMAND_SPECS_RE.test(content);
  if (hasRegisterBody && !declaresCommandSpecs) {
    const registerLine = lines.findIndex((line) => REGISTER_BODY_RE.test(line));
    violations.push({
      message:
        'Tool defines a `register()` body but declares no `commandSpecs`; the deprecated Commander mount hook must not be reintroduced (release 2.11.0 command plane).',
      severity: 'error',
      line: registerLine + 1,
      suggestion:
        'Replace the `register()` body with a `commandSpecs` array of CommandSpecs; the host mounts them via `mountCommandSpec`.',
    });
  }

  return violations;
}

export const checks = [
  defineCheck({
    id: '5e84b1fa-1149-4748-8519-848106647306',
    slug: 'command-surface-parity',
    description:
      'Every tool command resolves to a typed CommandSpec; no raw Commander access from a tool (release 2.11.0 command plane, Principle 6)',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture'],
    fileTypes: ['ts'],
    // Raw content: the patterns we detect (`.option(`, `cli.program as`) are code
    // tokens, and the path guard already restricts us to tool.ts files, so prose
    // cannot false-fire. Stripping comments is unnecessary and would hide a
    // commented-out re-acquisition of the program.
    contentFilter: 'raw',
    analyze: (content, filePath) => {
      if (!TOOL_REGISTRATION_PATH.test(filePath)) return [];
      return analyzeCommandSurfaceParity(content);
    },
  }),
];
