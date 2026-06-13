# OpenSIP CLI — Bug & Correctness Audit

Multi-agent audit: 28 subsystem finders + adversarial verification (188 agents). **133 raw findings → 116 confirmed** (each independently re-verified by a skeptic; 17 rejected as false positives). During the run the developer landed parallel fixes (commit `3042af47` + 27 working-tree files), so confirmed findings were re-checked against the **current working tree**.

## Disposition summary

| Bucket | critical | high | medium | low | total |
|---|---|---|---|---|---|
| LIVE | 2 | 21 | 47 | 44 | 114 |
| FIXED | 0 | 1 | 0 | 1 | 2 |

## 🔴 Live findings (present in current working tree)

### CRITICAL

#### 1. sql-injection check never fires in production: contentFilter 'strip-strings' blanks the SQL keywords its detection reads from string literals

- **Status:** 🔴 LIVE · **Severity:** critical · **Kind:** bug · **Subsystem:** `checks-typescript` · **Audit confidence:** high
- **Files:** `packages/fitness/checks-typescript/src/checks/security/sql-injection.ts:348`, `packages/fitness/checks-typescript/src/checks/security/sql-injection.ts:237-238`, `packages/fitness/checks-typescript/src/checks/security/sql-injection.ts:272-300`
- **Code:**
  ```ts
  contentFilter: 'strip-strings',
  ...
  const templateText = getTemplateText(node);
  if (!SQL_STRUCTURE_PATTERN.test(templateText)) return;
  ...
  const leftText = leftIsString ? node.left.text : '';
  if (leftIsString && SQL_KEYWORD_PATTERN.test(leftText) && !rightIsString) {
  ```
- **Concern:** False negative — security check produces zero findings in production
- **Trigger:** Any file with `db.query("SELECT * FROM users WHERE id = " + userId)` or a SQL template literal. Run through the real CLI (which registers the TypeScript LanguageAdapter), so the engine applies the 'strip-strings' filter before calling analyze().
- **Expected:** Detects SQL injection via string concatenation and template interpolation (one error-level finding for the SELECT concat).
- **Actual:** The engine (define-check.ts:114-115) passes the FILTERED content to analyze(); the TS strip-strings filter (lang-typescript filterContent) replaces string-literal CONTENT with equal-length spaces. So `node.left.text` becomes spaces, `getTemplateText` returns blanks, and SQL_KEYWORD_PATTERN / SQL_STRUCTURE_PATTERN never match. The check returns [] for every file. Proven end-to-end: analyzeSqlInjection on raw returns 1 finding, on stripStrings(raw) returns 0.
- **Why it matters:** This is a security gate (OWASP-top-10 SQL injection) that silently detects nothing in the dogfood/CI run and for every adopter — a false sense of coverage on a critical vulnerability class.
- **Recommendation:** Either drop the contentFilter for this check (use 'raw' / 'none' — it already filters suggestion/message properties and tagged templates structurally via the AST), or read SQL keyword content from the ORIGINAL unstripped source. The check fundamentally needs the literal text, which is exactly what strip-strings destroys.
- **Proving test:** In a real RunScope with the TS adapter registered, run the check (or call analyzeSqlInjection(stripStrings('db.query("SELECT * FROM t WHERE id=" + x)'),'r.ts')) and assert >=1 finding. Currently returns []. The existing tests pass only because they use `new RunScope()` with no TS adapter (applyContentFilter degrades to raw) or call analyzeSqlInjection with raw input directly.

#### 2. Profiling gate reads an UNDECLARED env var via the throwing EnvRegistry — every telemetry-enabled run aborts before the command body

- **Status:** 🔴 LIVE · **Severity:** critical · **Kind:** bug · **Subsystem:** `cli-misc` · **Audit confidence:** high
- **Files:** `packages/cli/src/telemetry/profiling.ts:42-53`, `packages/cli/src/telemetry/profiling.ts:60-61`, `packages/cli/src/env/host-env-specs.ts:26-78`
- **Code:**
  ```ts
  export function isProfilingEnabled(): boolean {
    const endpoint = hostEnv.get<string>('OTEL_EXPORTER_OTLP_ENDPOINT');
    if (!endpoint) return false;
    const explicit = hostEnv.get<string>('OPENSIP_PROFILING');   // <-- OPENSIP_PROFILING is NOT in CLI_ENV_SPECS
    ...
  }
  // startProfiling:
  if (isProfiling || !isProfilingEnabled()) return;   // OUTSIDE the try/catch below
  ```
- **Concern:** Swallowed/incorrect error handling, telemetry failure breaking the run (contradicts documented severable/fail-open contract)
- **Trigger:** Set OTEL_EXPORTER_OTLP_ENDPOINT (telemetry on) and do NOT set OPENSIP_PROFILING (the documented 'OTEL-only fallback' and 'recommended' modes both reach this read). Run any subcommand. The pre-action hook (pre-action-hook.ts:372) calls startProfiling(); isProfilingEnabled() calls hostEnv.get('OPENSIP_PROFILING'); OPENSIP_PROFILING is not declared in CLI_ENV_SPECS, so EnvRegistry.read throws "unknown variable 'OPENSIP_PROFILING'".
- **Expected:** Per the file's own contract ('Best effort — profiling failure must never break the run', and the supported OTEL-only mode), profiling silently enables/disables and never affects the command result.
- **Actual:** isProfilingEnabled() throws (verified at runtime: EnvRegistry.get on an undeclared canonical name throws). The throw is at startProfiling line 61, BEFORE the internal try/catch (lines 63-111), so it is NOT swallowed. It escapes the preAction hook (which has no try/catch around line 372), rejects program.parseAsync(), and is caught only by the top-level handleParseError → exit code 1 (RUNTIME_ERROR). Net effect: every command fails before its action body runs whenever the OTLP endpoint is set without OPENSIP_PROFILING explicitly defined.
- **Why it matters:** This breaks the primary command for any user who enables OpenTelemetry — a hard, silent regression of every fit/graph/sim run in CI or production observability setups. It directly contradicts the severable, fail-open design documented in the module header and ADR-0049.
- **Recommendation:** Declare an EnvVarSpec for OPENSIP_PROFILING in CLI_ENV_SPECS (host-env-specs.ts) so hostEnv.get returns undefined when unset instead of throwing (this also makes it appear in the generated env-surface reference, which it currently does not). The drift/coverage gate that asserts host-env-specs documents the surface should have caught the missing spec. As defense-in-depth, move the isProfilingEnabled() gate read inside startProfiling's try/catch (or make isProfilingEnabled itself never throw).
- **Proving test:** Set process.env.OTEL_EXPORTER_OTLP_ENDPOINT='http://localhost:4318' and ensure OPENSIP_PROFILING is unset, then call isProfilingEnabled() — today it throws; after declaring the spec it returns true (OTEL-only fallback) without throwing. Also add an end-to-end test that a command's preAction hook does not reject when the OTLP endpoint is set and OPENSIP_PROFILING is unset.

### HIGH

#### 3. incomplete-regex-escaping check never fires in production: it compares a string-literal second arg ('\$&') that strip-strings has blanked

- **Status:** 🔴 LIVE · **Severity:** high · **Kind:** bug · **Subsystem:** `checks-typescript` · **Audit confidence:** high
- **Files:** `packages/fitness/checks-typescript/src/checks/quality/incomplete-regex-escaping.ts:179`, `packages/fitness/checks-typescript/src/checks/quality/incomplete-regex-escaping.ts:133-136`
- **Code:**
  ```ts
  contentFilter: 'strip-strings',
  ...
  const secondArg = node.arguments[1];
  if (!secondArg || !ts.isStringLiteral(secondArg)) return null;
  if (secondArg.text !== String.raw`\$&`) return null;
  ```
- **Concern:** False negative — security check produces zero findings in production
- **Trigger:** `input.replace(/[a-z]/g, '\$&')` analyzed through the real CLI (TS adapter registered, strip-strings applied).
- **Expected:** Flags the incomplete escape pattern (missing special chars) as an error.
- **Actual:** strip-strings replaces the content of the second string literal `'\$&'` with equal-length spaces (proven: `'\$&'` -> `'   '`). So `secondArg.text` is `'   '`, the guard `secondArg.text !== '\$&'` is always true, and checkReplaceCall always returns null. The check can never produce a finding in production.
- **Why it matters:** A security check (regex-injection / incomplete-escaping) silently detects nothing for every real run.
- **Recommendation:** Use contentFilter 'none'/'raw' for this check (regex literals survive stripping, but the required `'\$&'` second-argument literal does not), or compare against the raw unstripped literal text.
- **Proving test:** With the TS adapter registered, feed `input.replace(/[a-z]/g, '\$&')`; assert one 'incomplete-escaping' finding. It currently returns none because the second-arg comparison fails on the blanked literal. Tests miss this because runCheck uses `new RunScope()` with no adapter, so content is never stripped.

#### 4. Whole test suite cannot catch strip-strings false negatives: harness uses an empty RunScope so the content filter degrades to raw, diverging from production

- **Status:** 🔴 LIVE · **Severity:** high · **Kind:** risk · **Subsystem:** `checks-typescript` · **Audit confidence:** high
- **Files:** `packages/fitness/checks-typescript/src/__tests__/behavior-fixtures.test.ts:21-26`, `packages/fitness/checks-typescript/src/__tests__/branch-fixtures-2.test.ts:17`, `packages/fitness/checks-typescript/src/__tests__/all-checks-execute.test.ts:23`, `packages/fitness/checks-typescript/src/__tests__/behavior-fixtures-6.test.ts:36`
- **Code:**
  ```ts
  // An empty scope makes applyContentFilter fall through to its no-adapter
  // "return raw" branch ...
  const testScope = new RunScope();
  ```
- **Concern:** Test gap — production code path (filtered content) is never exercised
- **Trigger:** Any check declaring contentFilter 'strip-strings'/'strip-strings-and-comments' whose detection depends on string-literal content.
- **Expected:** Tests exercise the same content the production CLI feeds to analyze() (string contents blanked for strip-strings checks).
- **Actual:** runCheck() wraps execution in `new RunScope()` with NO TypeScript adapter registered. applyContentFilter (content-filter-dispatch.ts:84-90) returns raw content when no adapter owns the extension. So every fixture test runs checks against RAW source, while production (bootstrap registers typescriptAdapter) runs them against STRIPPED source. This systematically hides the sql-injection and incomplete-regex-escaping false negatives (and any future strip-strings regression).
- **Why it matters:** The discrepancy means a check can be fully green in CI yet detect nothing in the real product. It already masks two security checks.
- **Recommendation:** Register the real TS LanguageAdapter into the test RunScope (so applyContentFilter actually strips for .ts files), or add an explicit per-check test that runs analyze() on the filtered content (apply typescriptAdapter.stripStrings before asserting). At minimum, add a regression test that the filtered-content path still finds the canonical fixtures for strip-strings checks.
- **Proving test:** Add a test that builds testScope with typescriptAdapter registered, runs sql-injection on the violation fixture, and asserts >=1 finding. Today that test FAILS, exposing the bug.

#### 5. CORS wildcard-origin detection is dead: strip-strings erases the literal `*` the regex requires

- **Status:** 🔴 LIVE · **Severity:** high · **Kind:** bug · **Subsystem:** `checks-universal` · **Audit confidence:** high
- **Files:** `packages/fitness/checks-universal/src/checks/security/cors-configuration.ts:16`, `packages/fitness/checks-universal/src/checks/security/cors-configuration.ts:18-19`, `packages/fitness/checks-universal/src/checks/security/cors-configuration.ts:82`
- **Code:**
  ```ts
  const WILDCARD_ORIGIN_PATTERN = /origin\s{0,10}[:=]\s{0,10}(['"])\*\1/g;
  ...
  contentFilter: 'strip-strings',
  ```
- **Concern:** false negative / security gate gap (string-literal content stripped before a pattern that depends on it)
- **Trigger:** A file with `app.use(cors({ origin: "*" }))` (or `origin: '*'`). The engine applies `strip-strings` (lang-typescript `stripStrings`) which replaces the inside of string literals with equal-length spaces, so `"*"` becomes `" "` before `analyze` runs.
- **Expected:** The wildcard-origin and wildcard-origin-with-credentials patterns flag `origin: "*"` as an error.
- **Actual:** `WILDCARD_ORIGIN_PATTERN` and `WILDCARD_WITH_CREDS_PATTERN` require a literal `\*` between the quote chars, but after strip-strings the `*` is a space, so they never match. I verified with the built `stripStrings`: `origin: "*"` -> `origin: " "`, and the regex matches the raw line but not the stripped line. Only the non-string patterns (`origin: true`, reflecting `request.headers.origin`) still work.
- **Why it matters:** This is the headline CORS misconfiguration (wildcard origin, plus the browser-rejected wildcard+credentials combo). The check silently passes the exact case its longDescription promises to catch, giving false security assurance. (The check is currently `disabled: true`, so impact is limited to adopters who enable it — but it is broken for everyone who does.)
- **Recommendation:** Use `contentFilter: 'raw'` for these wildcard patterns (the value `*` is a string-literal value that must be visible), or special-case the wildcard detection on raw content. Other checks that must see string-literal VALUES (e.g. `no-unimplemented-markers`) deliberately use `raw` for exactly this reason.
- **Proving test:** Unit: call the analyze function with `const cfg = cors({ origin: "*" });` and assert one error violation. It currently returns none. After switching to `raw` (and re-adding comment-skip), it returns the wildcard-origin error.

#### 6. ADR-0043 "tool-authoring bug" hard-reject keys on the tool's UUID instead of its config-namespace human key, so it never fires for modern tools

- **Status:** 🔴 LIVE · **Severity:** high · **Kind:** bug · **Subsystem:** `cli-bootstrap` · **Audit confidence:** high
- **Files:** `packages/cli/src/bootstrap/config-and-capabilities.ts:217-226`
- **Code:**
  ```ts
  const loadedToolIds = new Set(args.tools.list().map((t) => t.metadata.id));
  const toolBugs = report.unclaimed.filter((u) => loadedToolIds.has(u.namespace));
  if (toolBugs.length > 0) {
    ...
    throw new ConfigurationError(`Config declares ${names} but the loaded tool(s) of the same id contribute no Tool.config ...`);
  ```
- **Concern:** API contract mismatch / wrong conditional — code contradicts documented ADR-0043 behavior
- **Trigger:** A loaded tool whose human-key (metadata.name) equals a top-level config namespace, but which declares NO Tool.config, while the user's opensip-cli.config.yml contains that namespace block. Per ADR-0048 every first-party tool sets metadata.id to a UUID and metadata.name to the human key (e.g. fitness: id='afd68bd3-...', name='fitness'). The config namespace is the human key ('fitness'), and analyzeNamespaceClaims reports unclaimed namespaces as those human keys.
- **Expected:** When an unclaimed namespace equals a LOADED tool's identity but that tool contributes no Tool.config, the host hard-rejects with a ConfigurationError (CONFIGURATION_ERROR) — 'the block can never apply'. This is the ADR-0043 tool-authoring-bug guard documented in the function JSDoc and the inline comment at lines 179-185.
- **Actual:** loadedToolIds is built from t.metadata.id, which is the stable UUID for every tool that declares a stableId (all first-party tools, and any ADR-0048-compliant community tool). u.namespace is the human-readable config key. A UUID never equals a config namespace string, so toolBugs is always empty for modern tools. The intended hard-reject silently degrades to the warn-only branch (a 'not claimed by any loaded tool' stderr line), so a genuine tool-authoring bug is misreported as an uninstalled-tool forward-compat namespace and never fails the run.
- **Why it matters:** Defeats a deliberate correctness gate: a tool that ships a config block but forgets to contribute Tool.config will silently have its config ignored instead of failing loudly, exactly the silent-typo hole ADR-0043 was written to close. The guard is effectively dead code in production.
- **Recommendation:** Compare against the config-namespace key, i.e. use t.metadata.name (falling back to t.metadata.id only when name is absent), matching every other human-key comparison in the bootstrap (register-tools.ts:498/810/849, build-command-registration-input.ts:79). e.g. `new Set(args.tools.list().map((t) => t.metadata.name ?? t.metadata.id))`.
- **Proving test:** Add a test in config-and-capabilities.test.ts that registers a tool with metadata = { id: '<uuid>', name: 'mytool', ... } and NO config, with a config document containing `mytool:\n  x: 1`, and assert composeAndValidateToolConfig throws ConfigurationError. Note the existing test fixtures build tools with metadata={id: opts.id} (no name), so id==human-key and the bug is masked — the new fixture must set name separately from id to reproduce.

#### 7. `sessions list --summary-only` is a permanent no-op (kebab-case key never set by Commander)

- **Status:** 🔴 LIVE · **Severity:** high · **Kind:** bug · **Subsystem:** `cli-commands-mount` · **Audit confidence:** high
- **Files:** `packages/cli/src/commands/host-subcommand-groups.ts:81-95`
- **Code:**
  ```ts
  const opts = rawOpts as { tool?: ToolShortId; limit?: number; 'summary-only'?: boolean };
        return showHistory(ctx.datastore() as DataStore, {
          tool: opts.tool,
          limit: opts.limit,
          summaryOnly: !!opts['summary-only'],
        });
  ```
- **Concern:** option-name coercion / API contract mismatch
- **Trigger:** `opensip sessions list --summary-only` (with or without --json/--tool)
- **Expected:** The heavy per-session `payload` is dropped from each row (agent-friendly 'menu' output), per agent-catalog.ts and the flag's help text.
- **Actual:** Commander 15 camelCases multi-word flags: `--summary-only` is stored as `opts.summaryOnly`, not `opts['summary-only']`. The handler reads `opts['summary-only']` which is ALWAYS `undefined`, so `summaryOnly` is always `false`. The full payloads are always emitted; the flag does nothing.
- **Why it matters:** This is a headline agent-ergonomics feature explicitly advertised in agent-catalog.ts ('--summary-only is agent-friendly (omits heavy payloads)') and is the recommended pattern for token-sensitive agents. Token-conscious agents receive full payloads regardless, defeating the feature and inflating responses.
- **Recommendation:** Read `opts.summaryOnly` (Commander's camelCased key). Verified directly against commander@15: `new Option('--summary-only')` then parsing `--summary-only` yields `{ summaryOnly: true }` and `opts['summary-only'] === undefined`.
- **Proving test:** Mount buildSessionsListSpec via mountCommandSpec, parse `['sessions','list','--summary-only']`, and assert the handler invokes showHistory with `summaryOnly: true`. The existing history.test.ts bypasses Commander (calls showHistory directly with a boolean), so it cannot catch this.

#### 8. Repeated `--filter` on `sessions show` silently drops all but the last value (no array accumulator declared)

- **Status:** 🔴 LIVE · **Severity:** high · **Kind:** bug · **Subsystem:** `cli-commands-mount` · **Audit confidence:** high
- **Files:** `packages/cli/src/commands/host-subcommand-groups.ts:113-119`, `packages/cli/src/commands/host-subcommand-groups.ts:162-166`
- **Code:**
  ```ts
  {
          flag: '--filter',
          value: '<type>',
          description:
            'Filter replayed signals (repeatable): errors-only | warnings-only | top:<n>. ' +
            'Composable, e.g. --filter errors-only --filter top:20. ...',
        },
  ```
- **Concern:** repeatable-option accumulation / documented behavior contradiction
- **Trigger:** `opensip sessions show latest --tool fit --json --filter errors-only --filter top:20`
- **Expected:** Both filters compose: errors-only narrows to high-severity signals, then top:20 caps the count (as the help text and agent-catalog.ts examples promise).
- **Actual:** The `--filter` OptionSpec declares no `arrayDefault` and no `parse` accumulator reducer. Verified against commander@15: a repeated value option WITHOUT an argParser yields only the LAST occurrence (`{ filter: 'top:20' }`), not an array. `normalizeFilterOption` then returns `['top:20']`, so the `errors-only` filter is silently discarded. (Contrast fit's `--exclude`, which correctly declares `arrayDefault: []` + `parse: (val, prev) => [...prev, val]`.)
- **Why it matters:** Composable filters are a documented agent-ergonomics feature in agent-catalog.ts (multiple commonPatterns/examples use `--filter errors-only --filter top:N`). Agents relying on it get incorrectly-filtered historical results (e.g. they ask for 'top 20 errors' and get the top 20 of ALL severities), producing wrong data.
- **Recommendation:** Declare the `--filter` option as repeatable: add `arrayDefault: []` and `parse: (val, prev) => [...(prev as string[]), val]` (the same shape fit's `--exclude` uses). Then `normalizeFilterOption` receives a real array.
- **Proving test:** Mount buildSessionsShowSpec via mountCommandSpec, parse `['sessions','show','latest','--filter','errors-only','--filter','top:20']`, and assert the handler's `filters` is `['errors-only','top:20']`. session-show.test.ts does not exercise the `filters` option at all, so this is untested.

#### 9. Telemetry MeterProvider is constructed but never registered globally — all CLI metrics are silently dropped

- **Status:** 🔴 LIVE · **Severity:** high · **Kind:** bug · **Subsystem:** `cli-misc` · **Audit confidence:** high
- **Files:** `packages/cli/src/telemetry/sdk-init.ts:140-152`, `packages/cli/src/telemetry/sdk-init.ts:149-152`
- **Code:**
  ```ts
  meterProvider = new MeterProvider({ resource, readers: [ new PeriodicExportingMetricReader({...}) ] });
    // Note: we do not call a global register for meters here because
    // @opentelemetry/api metrics.getMeter reads from the global MeterProvider
    // once one is set via the SDK (the reader/exporter wiring above makes
    // the provider "active" for getMeter calls in this process).
  ```
- **Concern:** Stale/incorrect-data, API contract mismatch (metrics never exported)
- **Trigger:** Run any command with OTEL_EXPORTER_OTLP_ENDPOINT set. The histogram recorded in index.ts:153 (opensip_cli.command.duration_ms) and the counter in bootstrap/pre-action-hook.ts:334 (opensip_cli.commands.started) plus any tool-emitted metric resolve through core's getMeter -> metrics.getMeter, which reads the GLOBAL meter provider — which was never set.
- **Expected:** With the OTLP endpoint set, metrics (command duration histogram, commands-started counter) export to the collector, mirroring how traces export after provider.register().
- **Actual:** metrics.getMeter() returns the API no-op meter because no global MeterProvider was installed. @opentelemetry/sdk-metrics v2.8.0 MeterProvider has NO register() method and does NOT auto-install globally (verified: it only exposes getMeter/shutdown/forceFlush). Merely constructing it does nothing global. Result: every CLI/tool metric is silently discarded even when telemetry is on; only shutdownTelemetry()'s direct meterProvider.shutdown() touches it, and it has no instruments since getMeter never used it.
- **Why it matters:** Observability is a documented deliverable (ADR-0049 Phase 2 metrics). Operators who enable OTEL get traces but zero metrics, with no error — a silent data-integrity gap in the telemetry pipeline that is hard to notice in production.
- **Recommendation:** After constructing meterProvider, call metrics.setGlobalMeterProvider(meterProvider) (import { metrics } from '@opentelemetry/api'), the metrics-side analogue of provider.register() for traces. Then core's getMeter resolves to a real meter and instruments flow to the reader/exporter. Add a test mirroring spanIsRecording() that asserts a counter created via core getMeter is backed by the SDK provider (e.g. via a test InMemoryMetricReader / asserting the meter is not the no-op).
- **Proving test:** In sdk-init.test.ts: set OTEL_EXPORTER_OTLP_ENDPOINT, initTelemetry(); then assert metrics.getMeterProvider() is the SDK MeterProvider (not the API ProxyMeterProvider's no-op delegate), e.g. create a counter via getMeter('opensip-cli') and confirm it records to an attached InMemoryMetricReader. Today the assertion fails (no-op).

#### 10. Empty/whitespace-only number env var coerces to 0, silently disabling the fitness gate

- **Status:** 🔴 LIVE · **Severity:** high · **Kind:** bug · **Subsystem:** `config` · **Audit confidence:** high
- **Files:** `packages/config/src/precedence.ts:57-62`, `packages/config/src/precedence.ts:80-86`
- **Code:**
  ```ts
  case 'number': {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  ```
- **Concern:** Bad validation / numeric coercion contradicting documented behavior; wrong gate result
- **Trigger:** Set a `number`-typed env binding to an empty or whitespace-only string, e.g. `OPENSIP_FIT_FAIL_ON_ERRORS=` (a very common CI footgun where `OPENSIP_FIT_FAIL_ON_ERRORS=${UNSET_VAR}` expands to empty).
- **Expected:** An empty/whitespace env value should be treated as absent and dropped (fall back to file/defaults) — mirroring the `boolean` path, where `coerceBoolean('')` returns undefined and the value is dropped. The declaration docstring says number coercion drops a 'non-finite result'.
- **Actual:** `readEnvBindings` only skips `raw === undefined`; an empty string proceeds to `coerceEnvValue('number')`, where `Number('')` and `Number('  ')` both equal `0`, which is finite, so `0` is written into the resolved config. For `OPENSIP_FIT_FAIL_ON_ERRORS=`, this sets `fitness.failOnErrors = 0`, which the fitness schema documents as '0 = never fail on errors' (packages/fitness/engine/src/config/fitness-config-schema.ts:43-44). The CI dogfood gate then passes despite error-level findings.
- **Why it matters:** This silently disables the error gate (and warning gate) that CI relies on (the dogfood ratchet, ADR-0020). An unset/empty env var in a CI pipeline turns a hard gate into a no-op without any warning — a wrong-gate-result correctness and integrity failure. The asymmetry with the boolean path (which correctly drops empty) shows this is unintended.
- **Recommendation:** In `readEnvBindings`, skip empty/whitespace-only raw values before coercion (`if (raw.trim() === '') continue;`), or in `coerceEnvValue('number')` reject empty/whitespace: `const t = raw.trim(); if (t === '') return undefined; const n = Number(t); return Number.isFinite(n) ? n : undefined;`. Also consider rejecting hex/`Infinity` surprises by validating the trimmed string.
- **Proving test:** resolveConfig({ declarations: [fitnessDecl], env: { OPENSIP_FIT_FAIL_ON_ERRORS: '' } }) — assert resolved.fitness.failOnErrors === 1 (the default), NOT 0. Add a sibling case with '   ' (whitespace). The existing 'drops an env value that fails coercion' test only covers 'not-a-number' (NaN), not empty→0.

#### 11. Suppression directive scanner detects comment openers by indexOf-anywhere, causing both false-negative AND false-positive suppression

- **Status:** 🔴 LIVE · **Severity:** high · **Kind:** bug · **Subsystem:** `core-lang-signals` · **Audit confidence:** high
- **Files:** `packages/core/src/signals/suppress.ts:136-166`, `packages/core/src/signals/suppress.ts:139-147`
- **Code:**
  ```ts
  for (const [opener, length] of COMMENT_OPENERS) {
    const idx = line.indexOf(opener);
    if (idx !== -1) { commentIndex = idx; sliceLen = length; break; }
  }
  if (commentIndex === -1) return null;
  const afterComment = line.slice(commentIndex + sliceLen).trimStart();
  if (!afterComment.startsWith(directiveKeyword)) return null;
  ```
- **Concern:** Incorrect text parsing / contradicts documented behavior — comment opener is located by `indexOf` anywhere in the line rather than by lexically recognizing the comment, so an opener-shaped substring inside a string literal (or an earlier comment) wins.
- **Trigger:** Two reachable scenarios on raw source lines (fitness passes raw `fileCache.get()` content; graph passes raw file content): (1) FALSE NEGATIVE — a real trailing directive is missed when an earlier `//` / `https://` appears in a string, e.g. `const s = "a//b"; // @fitness-ignore-next-line my-check`. (2) FALSE POSITIVE — directive text inside a STRING LITERAL or nested comment is parsed as a real directive, e.g. `const doc = "use // @fitness-ignore-file sql-injection to waive";` suppresses `sql-injection` for the ENTIRE file.
- **Expected:** A directive is recognized only when it sits in an actual comment. The leading-position helper `stripCommentOpener` (comment-openers.ts) already does this correctly with `startsWith`; the docs (docs/public/20-fit/03-ignore-directives.md:45) treat directives as living in comments, not strings.
- **Actual:** `extractDirectiveId` picks the first COMMENT_OPENERS entry (in list order //, /*, <!--, #) found ANYWHERE via `indexOf`, then requires the directive to immediately follow. A `//` inside a string before a trailing directive comment swallows the match (false negative). Directive text inside a string literal is treated as a genuine file/next-line directive (false positive), silently disabling a check for a whole file.
- **Why it matters:** This is the single shared suppression engine for `fit` and `graph` (used by fitness/ignore-processing.ts and graph/apply-suppressions.ts). A false negative makes a legitimate waiver leak as a finding (gate/CI fails unexpectedly, contributor confusion). A false positive silently suppresses real findings — including security checks — for an entire file based on text that merely appears inside a string literal, which is both a correctness and a security regression and is undetectable without reading every string in the repo.
- **Recommendation:** Recognize the comment lexically rather than via substring search. Reuse the leading-anchored `stripCommentOpener` semantics: scan from the line start, skipping leading non-comment code only when it is verified to be outside string/char literals, or require the directive's comment opener to be the first comment token after stripping the file's string regions (the language adapter's stripStrings is already available). At minimum, anchor the opener at a position not preceded by an unbalanced quote on the line. Add the two regression cases below.
- **Proving test:** Unit test on `scanSuppressionDirectives`: (a) `scanSuppressionDirectives('const s = "a//b"; // @fitness-ignore-next-line my-check\ncode', FITNESS_KEYWORDS)` MUST record a next-line directive targeting line 2 for `my-check` (currently records none). (b) `scanSuppressionDirectives('const doc = "// @fitness-ignore-file sql-injection";', FITNESS_KEYWORDS).fileIgnoredIds` MUST be empty (currently contains `sql-injection`).

#### 12. CommandSpec.scope is a documented-but-dead contract field — host gates project scope by a hardcoded command-name set, not the declared scope requirement

- **Status:** 🔴 LIVE · **Severity:** high · **Kind:** bug · **Subsystem:** `core-tools` · **Audit confidence:** high
- **Files:** `packages/core/src/tools/command-spec.ts:177-184`, `packages/core/src/tools/command-spec.ts:229-230`
- **Code:**
  ```ts
  /**
   * Whether the command needs a resolved project scope ...
   * - `project` — needs the entered RunScope (every run/list/export command).
   * - `none` — scope-agnostic (e.g. `completion`, `configure`).
   */
  export type CommandScopeRequirement = 'project' | 'none';
  ...
    /** Whether the host enters a project scope before the handler. */
    readonly scope: CommandScopeRequirement;
  ```
- **Concern:** API contract mismatch / code contradicting documented behavior
- **Trigger:** A third-party (or any) tool declares a CommandSpec with `scope: 'none'` for a command that should run outside any opensip-cli project. Run that command from a directory with no project.
- **Expected:** Per the field's JSDoc, the host should NOT require/enter a project scope before invoking a `scope: 'none'` command (it should run as a project-agnostic command like `configure`/`completion`).
- **Actual:** The host never reads `CommandSpec.scope`. The 'no project found' bailout is gated by a hardcoded NAME set `PROJECT_AGNOSTIC_COMMANDS = {init, configure, completion, uninstall}` (packages/cli/src/bootstrap/pre-action-guards.ts:38, used at :109 `if (project.scope !== 'none' || PROJECT_AGNOSTIC_COMMANDS.has(cmdName)) return;`). A tool command whose name is not in that set is blocked with 'No OpenSIP CLI project found' (exit 2) regardless of its declared `scope: 'none'`. Grep confirms no production code reads `spec.scope`; mount-command-spec.ts and the pre-action hook ignore it.
- **Why it matters:** The Tool plugin contract advertises a knob that does nothing. A community tool cannot author a project-agnostic command — the only escape hatch (the NAME allow-list) is closed and host-owned. The field gives tool authors a false belief about behavior, and any reliance on it is silently wrong. This directly undermines the 'tools declare commandSpecs, host honors them' invariant.
- **Recommendation:** Either (a) make the pre-action 'no project' guard consult the dispatched CommandSpec.scope (resolve the spec by command name and treat `scope:'none'` as project-agnostic), retiring the hardcoded PROJECT_AGNOSTIC_COMMANDS set; or (b) if the field is intentionally not wired yet, document it as RESERVED/non-operative in command-spec.ts so authors are not misled. Option (a) is the correct architecture per the 'one command surface' contract.
- **Proving test:** Author a tool with a CommandSpec `{ name: 'mytool-ping', scope: 'none', output: 'command-result', commonFlags: [], handler }`, register it, and run `opensip mytool-ping` from a directory with no opensip-cli project. Observe it fails with 'No OpenSIP CLI project found' (exit 2) instead of running — proving `scope:'none'` is ignored.

#### 13. BaselineRepo.save() crashes with 'too many SQL variables' at >=8192 fingerprints (un-chunked bulk insert)

- **Status:** 🔴 LIVE · **Severity:** high · **Kind:** bug · **Subsystem:** `datastore` · **Audit confidence:** high
- **Files:** `packages/datastore/src/baseline-repo.ts:54-67`
- **Code:**
  ```ts
  this.datastore.transaction((tx) => {
    tx.delete(toolBaselineEntries).where(eq(toolBaselineEntries.tool, tool)).run();
    if (rows.length > 0) {
      tx.insert(toolBaselineEntries).values(rows).run();
    }
  ```
- **Concern:** Scalability / hard failure of the gate-save path; un-chunked multi-row INSERT exceeds SQLite's bound-parameter ceiling.
- **Trigger:** A tool run that produces >=8192 distinct fingerprints, saved via `cli.saveBaseline` -> `BaselineRepo.save`. Drizzle builds ONE multi-row INSERT with 4 bound params per row (tool, fingerprint, payload, captured_at). The bundled SQLite (3.53.1, SQLITE_MAX_VARIABLE_NUMBER=32766) caps at 32766/4 = 8191 rows; the 8192nd row throws `too many SQL variables`. This is the EXACT intended adoption scenario from CLAUDE.md ('adopters with a backlog: failOnErrors:0 = ratchet-only' accumulates ALL existing violations into the baseline).
- **Expected:** save() persists an arbitrarily large baseline (graph/fitness on a large monorepo) successfully.
- **Actual:** The transaction throws `SQLITE_ERROR: too many SQL variables`, the whole `--gate-save` aborts (re-thrown at baseline-repo.ts:85), and no baseline is captured — the ratchet is unusable on exactly the large-backlog repos it was designed for.
- **Why it matters:** Wrong gate result / unusable feature: large adopter repos cannot capture a baseline at all, defeating the documented ratchet-only adoption path. The failure is abrupt and the error message ('too many SQL variables') gives no hint of the real cause.
- **Recommendation:** Chunk the insert (e.g. batch `rows` into groups of <=8000 and call `tx.insert(...).values(chunk).run()` per chunk inside the same transaction), or use prepared per-row inserts in a loop inside the transaction. Add a guard/test at a fixed safe batch size.
- **Proving test:** Construct a BaselineRepo over a memory DataStore and call `repo.save('graph', entries)` with 9000 unique fingerprints; today it throws 'too many SQL variables'. Reproduced directly through the repo's Drizzle insert path: building `db.insert(toolBaselineEntries).values(rows).run()` with 8192 rows throws `too many SQL variables` (verified empirically against better-sqlite3 12.10.0 / SQLite 3.53.1). The fix should make this insert succeed.

#### 14. `fit --exclude <slug>` is a documented, parsed flag that is never consumed — excluded checks still run (and can fail the gate)

- **Status:** 🔴 LIVE · **Severity:** high · **Kind:** bug · **Subsystem:** `fit-cli-gate` · **Audit confidence:** high
- **Files:** `packages/fitness/engine/src/cli/fit/fit-command-spec.ts:108-114`, `packages/fitness/engine/src/cli/fit.ts:147-154`
- **Code:**
  ```ts
  // fit-command-spec.ts
  { flag: '--exclude', value: '<slug>', description: 'Exclude check (repeatable)', arrayDefault: [], parse: (val, prev) => [...(prev as string[]), val] },
  
  // fit.ts (executeFit) — disabledChecks never merges args.exclude:
  disabledChecks: fitnessResolved?.disabledChecks ?? signalersConfig.fitness.disabledChecks,
  ```
- **Concern:** Documented behavior contradicted; check-suppression silently ignored
- **Trigger:** `opensip fit --exclude some-check` (or a `cli.exclude: [some-check]` config default, which cli-defaults.ts pushes into opts.exclude).
- **Expected:** The check whose slug is passed to --exclude is not run (per docs/public/70-reference/01-cli-commands.md:122 "Exclude check by slug" and the flag's own help text).
- **Actual:** `FitOptions.exclude` is populated (by the flag's parse fn and by `mergeConfigDefaults` in cli-defaults.ts) but NO code path in the fit pipeline reads `args.exclude`. executeFit only passes `disabledChecks` (from config), the live runner / json / gate / non-TTY paths all call `executeFit(args)` which ignores `exclude`, and the forked worker (fit-worker.ts) JSON-serializes args and re-runs executeFit. The excluded check runs normally and its findings count toward the gate verdict.
- **Why it matters:** A user who runs `--exclude flaky-check` (or sets `cli.exclude`) believes they suppressed a check; it still runs, still emits findings, and can flip `verdict.passed` to false — failing CI on a check the operator explicitly opted out of. Silent no-op of a documented suppression control is a correctness/trust defect.
- **Recommendation:** In `executeFit`, merge `args.exclude` into the service's `disabledChecks` set, e.g. `disabledChecks: [...(fitnessResolved?.disabledChecks ?? signalersConfig.fitness.disabledChecks), ...args.exclude]`. Add a regression test asserting an excluded slug does not appear in the run's units/signals.
- **Proving test:** Build a project with two checks; run `executeFit({ ...args, exclude: ['check-a'] })` and assert the returned envelope's `units` contains only `check-b`. Also assert `opensip fit --exclude check-a --json` omits check-a from the units array. Both currently fail (check-a present).

#### 15. Throwing onCheckComplete callback double-counts a check into the session, corrupting summary counts and the envelope

- **Status:** 🔴 LIVE · **Severity:** high · **Kind:** bug · **Subsystem:** `fit-recipes` · **Audit confidence:** high
- **Files:** `packages/fitness/engine/src/recipes/check-result-processor.ts:233-246`, `packages/fitness/engine/src/recipes/run-one-check.ts:193-228`
- **Code:**
  ```ts
  updateSessionForSuccess(session, checkResult, tags);
  ...
  callbacks.onCheckComplete?.(checkSlug, summary, checkIndex, totalChecks);  // throws AFTER session already mutated
  // run-one-check.ts catch:
  } catch (error) {
    ...
    const processOutput = processErrorResult(ctx, { checkId, checkSlug, ... });  // pushes a SECOND result for the same check
  ```
- **Concern:** Invalid state transition / state corruption: a passing check is recorded twice (once as pass, once as fail) when a user/progress callback throws.
- **Trigger:** A check passes; processSuccessResult runs updateSessionForSuccess (pushes the result, completedChecks++, passedChecks++), then calls onCheckComplete. The production onCheckComplete (buildFitCallbacks → onProgress → live Ink renderer) throws. run-one-check.ts's catch (designed to 'recover' a callback throw) calls processErrorResult, which pushes a SECOND result and increments completedChecks/failedChecks/totalErrors again.
- **Expected:** A single check contributes exactly one entry to session.checkResults and increments completedChecks by exactly one (either pass or fail, not both). A throwing progress callback should not corrupt run accounting.
- **Actual:** session.checkResults contains two entries for the same check; completedChecks is inflated by 2; the check is counted as BOTH passed and failed (passedChecks+failedChecks > totalChecks); skippedChecks = totalChecks - completedChecks can go negative; passRate denominator/numerator are wrong; and buildFitEnvelope (built from checkResults) emits a duplicate unit + a phantom error signal, which can flip the gate verdict.
- **Why it matters:** Corrupts the run summary and the gate verdict on a real interactive failure path (Ink renderer / progress callback exceptions). The score, pass/fail counts, and the SARIF/Code-Scanning output all derive from these counters.
- **Recommendation:** Either invoke onCheckComplete BEFORE mutating the session, or move the user-callback invocations outside the session-mutation transaction so a callback throw cannot trigger a second processErrorResult on an already-recorded check. Alternatively, in run-one-check.ts's catch, do not re-process a result that was already recorded; wrap only the callback in its own try/catch and log+swallow.
- **Proving test:** In run-one-check.test.ts's 'catches a throw raised while processing a successful result' test, pass a shared session via makeProcessorContext and assert AFTER runOneCheck: expect(ctx.session.checkResults.length).toBe(1) and expect(ctx.session.completedChecks).toBe(1). Today checkResults.length === 2 and completedChecks === 2, proving the double-count.

#### 16. Shared module-global fileCache is prewarmed/cleared by the recipe service per-run, breaking documented concurrent-scope (SaaS) isolation

- **Status:** 🔴 LIVE · **Severity:** high · **Kind:** bug · **Subsystem:** `fit-recipes` · **Audit confidence:** medium
- **Files:** `packages/fitness/engine/src/recipes/service.ts:240-247`, `packages/fitness/engine/src/recipes/service.ts:346-350`
- **Code:**
  ```ts
  // prepareExecution:
  await fileCache.prewarm(cwd, patterns);
  ...
  // finally of executeRecipeInScope:
  void clearParseCache();
  fileCache.clear();
  ```
- **Concern:** Concurrency / cache-consistency: fileCache is a single process-global Map (packages/fitness/engine/src/framework/file-cache.ts:38,215), not scope-bound, yet the service prewarms into it and clears it in finally. The parse cache was made scope-bound (audit F2) but the file cache was not.
- **Trigger:** Two RunScopes run executeFit concurrently in one process (the explicitly supported SaaS path — see packages/cli/src/__tests__/saas-mode-smoke.test.ts which calls executeFit for two projects inside Promise.all). Run A's finally calls fileCache.clear() while Run B is still executing; B's getCached() then misses, and scope-empty checks in B fall back to fileCache.paths() which returns A's+B's files merged (execution-context.ts:168).
- **Expected:** Each concurrent RunScope carries independent fitness file state (CLAUDE.md: 'two concurrent scopes carry independent fitness state'); a check in project B only ever sees project B's files, and one run's teardown never wipes another run's cache.
- **Actual:** A's prewarm and clear race with B's reads on the same Map. A scope-empty check in run B can analyze run A's (different project/tenant) files via the shared fileCache.paths() fallback, and A's finally fileCache.clear() empties the cache B is using. Cross-scope data leak / wrong-file analysis under concurrency.
- **Why it matters:** In SaaS mode this is a cross-tenant correctness and data-isolation failure: checks can scan another tenant's files, and gate results become nondeterministic depending on interleaving.
- **Recommendation:** Make the file cache scope-owned the same way the parse cache is (hang it off RunScope, read via currentScope()), so prewarm/clear operate on the per-run instance. Until then the service must not clear a process-global cache that a concurrent run may be using.
- **Proving test:** Extend saas-mode-smoke.test.ts: give project A many large files and project B a scope-empty (no-target) universal check; run both via Promise.all and assert B's check only reports files under projectB. With the shared cache, B observes projectA files (or an emptied cache mid-run).

#### 17. includeViolations severity mapping uses `=== 'high'`, mislabeling `critical` signals as warnings and dropping them from the gate verdict

- **Status:** 🔴 LIVE · **Severity:** high · **Kind:** bug · **Subsystem:** `fit-recipes` · **Audit confidence:** medium
- **Files:** `packages/fitness/engine/src/recipes/check-result-processor.ts:221-228`
- **Code:**
  ```ts
  violations: effectiveSignals.map((s) => ({
    ...
    severity: s.severity === 'high' ? ('error' as const) : ('warning' as const),
    ...
  })),
  ```
- **Concern:** API contract mismatch with the canonical error-rung policy: core defines isErrorSeverity = critical || high (packages/core/src/types/signal.ts:80-82), but this maps only 'high' to 'error'. 'critical' (and 'low') both fall into the 'warning' branch.
- **Trigger:** A check emits a Signal with severity 'critical' into result.signals (allowed by the Signal type and by ResultBuilder.addSignal/createSignal; the standard defineCheck path lifts only to high/medium today, so this requires a check that constructs a critical signal directly). includeViolations is true on the production fit path (cli/fit.ts:152).
- **Expected:** A critical signal is on the error rung and must be labeled 'error' in RecipeCheckResult.violations, so violationToSignal maps it back to 'high' (error rung) and the envelope verdict (passed ⇔ no critical/high) fails the gate.
- **Actual:** A 'critical' violation is labeled 'warning' → violationToSignal maps warning→medium → it lands on the warning rung in the SignalEnvelope. A run whose only findings are critical would produce a PASS envelope verdict (and pass the gate), even though the check's own errorCount (via countErrors) correctly counted it as an error. The two disagree.
- **Why it matters:** The gate exit code is derived from the envelope verdict (ADR-0035), so a critical-only finding could silently pass CI. The mislabeling also misrenders critical findings as warnings in the dashboard/SARIF.
- **Recommendation:** Replace `s.severity === 'high'` with the canonical predicate `isErrorSeverity(s.severity)` (critical || high) so violations carry the correct error rung regardless of which severities a check emits.
- **Proving test:** Add a check that emits createSignal({severity:'critical'}) into result.signals, run it through processSuccessResult with includeViolations:true, and assert the produced violation.severity === 'error'; then build the envelope and assert verdict.passed === false. Today the violation is 'warning' and the verdict passes.

#### 18. `graph --workspace` silently ignores --gate-save / --gate-compare (no baseline saved, no hard-fail on error findings)

- **Status:** 🔴 LIVE · **Severity:** high · **Kind:** bug · **Subsystem:** `graph-cli` · **Audit confidence:** high
- **Files:** `packages/graph/engine/src/cli/graph.ts:164-168`, `packages/graph/engine/src/cli/graph.ts:673-682`, `packages/graph/engine/src/cli/graph.ts:993-1074`
- **Code:**
  ```ts
  if (opts.workspace === true) {
    await executeWorkspaceGraph(opts, cli, profile);
    writeProfileIfRequested(opts, profile);
    return undefined;
  }
  ```
- **Concern:** code path contradicts documented gate behavior — a CI gate is a silent no-op under --workspace
- **Trigger:** `opensip graph --workspace --gate-save` (or `--gate-compare`). `validateMutuallyExclusiveFlags` only rejects gateSave+gateCompare and workspace+paths; it does NOT reject workspace+gate. `executeGraph` then takes the `opts.workspace === true` branch and returns before any gate dispatch. `executeWorkspaceGraph` never reads gateSave/gateCompare, and the spawned children run `graph <rootDir> --json` (spawnGraphChild adds only --no-cache/--resolution/--language/--recipe), so no gate runs anywhere.
- **Expected:** Per CLAUDE.md and docs/public/40-graph/02-rules-and-gating.md, `--gate-save` must record the baseline AND hard-fail on any error-level finding; `--gate-compare` must fail on net-new findings. The combination should either be rejected (like workspace+paths) or honored.
- **Actual:** The gate is completely ignored: no baseline is written, no error-level hard-fail occurs, and the run exits 0 unless a child process crashes (the only thing that flips anyChildFailed → exit RUNTIME_ERROR).
- **Why it matters:** An adopter wiring `graph --workspace --gate-save` (a natural choice for a polyglot/large monorepo, which is exactly what --workspace targets) believes they have a security gate, but it is a silent no-op — error-level findings pass CI undetected.
- **Recommendation:** Extend validateMutuallyExclusiveFlags to reject `--workspace` with `--gate-save`/`--gate-compare` (matching the workspace+paths rejection) with a clear ConfigurationError, OR implement aggregate gating in executeWorkspaceGraph. Rejecting fail-fast is the minimum safe fix.
- **Proving test:** Run executeGraph with `{ workspace: true, gateSave: true }`: assert it either throws ConfigurationError or that cli.saveBaseline was invoked. Today neither happens (saveBaseline is never called; exit is SUCCESS).

#### 19. Partial shard-worker failure silently produces and persists an incomplete catalog; failedShardIds is computed but never propagated or gated

- **Status:** 🔴 LIVE · **Severity:** high · **Kind:** bug · **Subsystem:** `graph-orchestrate` · **Audit confidence:** high
- **Files:** `packages/graph/engine/src/cli/orchestrate/sharded-graph.ts:169-177`, `packages/graph/engine/src/cli/orchestrate/sharded-graph.ts:249-252`, `packages/graph/engine/src/cli/orchestrate/sharded-graph.ts:283-292`, `packages/graph/engine/src/cli/graph.ts:520-528`
- **Code:**
  ```ts
  for (const failure of built.failures) { logger.error({ evt: 'graph.sharded.shard_failed', ... }); }
  ...
  if (useCache && catalogRepo) { persistShardedCatalog(catalogRepo, built.fragments, shards, catalogToPersist); }
  ...
  failedShardIds: built.failures.map((f) => f.shardId),
  ```
- **Concern:** swallowed/incorrect error handling; data integrity (wrong gate result + stale-but-authoritative cache)
- **Trigger:** Any shard worker exits non-zero (OOM on a large package, transient I/O, an unhandled parse panic, or unparseable stdout). runShardsInParallel collects it as a ShardFailure rather than throwing.
- **Expected:** A shard failure should either abort the build (fail loud, like assertUniqueShardIds) or mark the result degraded/partial so the gate does not pass on an incomplete graph and the incomplete catalog is not persisted as the authoritative full catalog.
- **Actual:** buildShardedGraph logs the failure, then merges only the surviving shards' fragments, runs indexes/features/rules over the truncated catalog (fewer functions => fewer/zero findings => gate PASSES), and persists that truncated catalog via catalogRepo.replaceAll regardless of failures. failedShardIds is returned by runShardedGraph but runShardedBuild (graph.ts:520-528) drops it entirely — it is consumed nowhere in the engine (grep shows only the assignment and the type field), so it never affects the exit code, gate, or the JSON/SARIF completeness field. In the extreme (all shards fail, none cac…
- **Why it matters:** The dogfood/CI gate and customers rely on the graph gate to fail on real findings. A transient worker crash converts a real graph into a quietly smaller one that passes the gate and is cached as the authoritative full catalog (consumed by report/dashboard). This is a silent correctness/data-integrity regression masquerading as a clean run.
- **Recommendation:** Thread built.failures through to the RunGraphResult and either (a) throw/non-zero-exit when failures.length>0 (matching the fail-loud posture of assertUniqueShardIds), or (b) set catalog completeness='partial' and skip replaceAll persistence of a partial catalog (mirroring the MemoryPressureError partial path). At minimum, do not persist the merged full catalog when built.failures is non-empty.
- **Proving test:** Inject a runShardsInParallel that returns one ShardFailure (e.g. spy/stub a worker exiting code 1) for a 2-shard fixture where shard B owns functions called from shard A. Assert that runShardedGraph either rejects/marks degraded, that the returned catalog is NOT missing shard B's functions silently while reporting cacheHit/success, and that catalogRepo.replaceAll is NOT called with the truncated catalog.

#### 20. renderCatalogJson materializes the entire export as one JS string (JSON.stringify) — RangeError / OOM risk on the documented 100k-file target

- **Status:** 🔴 LIVE · **Severity:** high · **Kind:** risk · **Subsystem:** `graph-render-persist` · **Audit confidence:** medium
- **Files:** `packages/graph/engine/src/render/catalog-json.ts:358`, `packages/graph/engine/src/cli/graph-modes.ts:176-189`
- **Code:**
  ```ts
  return JSON.stringify(doc, null, 2);
  ```
- **Concern:** resource lifecycle / scalability of serialization
- **Trigger:** Export a very large monorepo catalog (the file header explicitly targets '100k-file repos'). Symbols + edges with sha256 hex ids, file paths, and 2-space pretty-print can produce a document whose serialized length exceeds V8's max string length (~536,870,888 chars).
- **Expected:** Per the file header — 'Streams to a file at the orchestrate-CLI level ... because catalog JSON for 100k-file repos exceeds practical stdout buffer sizes' — the export should not require holding the whole document in a single in-memory string.
- **Actual:** `renderCatalogJson` builds the full `symbols`/`edges` arrays in memory and returns `JSON.stringify(doc, null, 2)` as a single string; `graph-modes.ts` then `writeFileSync(path, json)`. Nothing streams. For a sufficiently large catalog, `JSON.stringify` throws `RangeError: Invalid string length` (V8 max string ~536MB) before the file is ever written, aborting the run; even below that limit peak memory is the full pretty-printed document plus the source arrays.
- **Why it matters:** The documented headline use case (100k-file repos) is exactly the case that can blow the V8 string cap or spike memory, causing a hard failure of catalog export rather than the intended file output.
- **Recommendation:** Stream the document: write `provenance` + open arrays, then write each symbol/edge row incrementally to a write stream (still sorted by id) instead of building one giant string; or chunk the JSON. At minimum, document and guard the size ceiling and surface a typed error instead of a raw RangeError.
- **Proving test:** Generate a catalog whose JSON serialization exceeds ~537M chars (or stub `JSON.stringify` to assert it is never called on the whole document) and confirm the export still completes; today it throws RangeError.

#### 21. filterContent corrupts code positions and leaks string/comment content for any source containing astral (non-BMP) characters

- **Status:** 🔴 LIVE · **Severity:** high · **Kind:** bug · **Subsystem:** `lang-adapters` · **Audit confidence:** high
- **Files:** `packages/languages/lang-typescript/src/filter.ts:228`, `packages/languages/lang-typescript/src/filter.ts:255`, `packages/languages/lang-typescript/src/filter.ts:301-311`
- **Code:**
  ```ts
  const chars = [...content];
  ...
  replaceCharsInRange(chars, start + 1, end - 1, stringRegions);
  ...
  const charsNoComments = [...content];
  for (const region of stringRegions) { for (let i = region.start; i < region.end; i++) {
  ```
- **Concern:** ser/deser & position-offset mismatch (UTF-16 vs code-point indexing)
- **Trigger:** Any .ts/.tsx/.js file containing an astral character (emoji, e.g. 😀, or any U+10000+ codepoint) anywhere before a string literal or comment. The TS scanner's getTokenStart()/getTokenEnd() return UTF-16 code-unit offsets, but `chars = [...content]` produces a CODE-POINT array (a surrogate pair collapses into one element). After the first astral char, every scanner offset is misaligned, so the blanking writes spaces at the wrong indices.
- **Expected:** Per the module's own invariant ('preserving line/column positions', 'preserve byte length so line/column positions remain stable'), string/comment regions are blanked exactly at their scanner offsets; real code is untouched.
- **Actual:** Proven: filterContent('const a = "hi 😀 there";\nconst getDatabase = 1;\n').code === 'const a = "           ;\n...' — the string's closing quote is overwritten and the trailing `;` is left, off by one. With a second literal later in the file, content leaks through un-stripped while real delimiters get blanked (e.g. "MY_SECRET" -> '"M         ;'). The companion core helper applyRegions deliberately uses src.split('') with the comment 'split('') keeps UTF-16 unit indexing; spread/Array.from use code points and break offsets' — filter.ts violates that exact rule.
- **Why it matters:** adapter.stripStrings/stripComments for TS/JS route through filterContent (via content-filter-dispatch.applyContentFilter), so EVERY regex/text check that strips strings or comments on a TS/JS file with an emoji/astral char gets corrupted output: real code after the astral char can be silently blanked (false negatives — missed violations) and string/comment content can shift into view (false positives). Emoji/astral chars are common in comments, i18n strings, and test fixtures. This is a wrong-gate-result + data-integrity bug.
- **Recommendation:** Replace `const chars = [...content]` (line 228) and `const charsNoComments = [...content]` (line 301) with `content.split('')` (UTF-16 code-unit array), matching core's applyRegions. Then `.join('')` reconstitutes correctly. No other logic changes needed.
- **Proving test:** const { filterContent } = require('@opensip-cli/lang-typescript'); const r = filterContent('const x = "😀";\nconst secret = "MY_SECRET";\n'); expect(r.code).toBe('const x = "  ";\nconst secret = "         ";\n'); // closing quotes preserved, both string bodies fully blanked, all code intact

#### 22. SARIF region can emit startColumn without startLine — violates SARIF 2.1.0 region invariant, can cause GitHub Code Scanning to reject the whole upload

- **Status:** 🔴 LIVE · **Severity:** high · **Kind:** bug · **Subsystem:** `output` · **Audit confidence:** high
- **Files:** `packages/output/src/format/signal-sarif.ts:143-156`
- **Code:**
  ```ts
  const startLine = atLeastOne(signal.code?.line ?? signal.line);
  const startColumn = atLeastOne(signal.code?.column ?? signal.column);
  ...
  ...(startLine !== undefined || startColumn !== undefined
    ? { region: {
          ...(startLine !== undefined && { startLine }),
          ...(startColumn !== undefined && { startColumn }),
        } }
    : {}),
  ```
- **Concern:** SARIF 2.1.0 conformance
- **Trigger:** A signal whose effective line is undefined or < 1 (so startLine is dropped) but whose effective column is >= 1 (so startColumn survives). The region is then emitted as `{ startColumn: N }` with no startLine.
- **Expected:** Per SARIF 2.1.0 §3.30.5, if region.startColumn is present then region.startLine SHALL also be present. The emitter should drop startColumn (or omit the region) whenever startLine is absent.
- **Actual:** The two coordinates are decided independently. A column-only signal produces `region: { startColumn: N }`, an invalid SARIF region object. Strict SARIF validators (and GitHub Code Scanning) can reject the entire uploaded run, silently killing the dogfood graph/fit ratchet for that PR.
- **Why it matters:** formatSignalSarif is the single SARIF write path for both `fit --gate-save --sarif` and `graph --sarif` dogfood uploads (deliver-envelope.ts writeEnvelopeSarif). A non-conformant region risks rejection of the whole upload, defeating the net-new ratchet that gates PRs.
- **Recommendation:** Make startColumn conditional on startLine being present: compute `const col = startLine !== undefined ? startColumn : undefined;` and only spread startColumn when startLine is set. Equivalently, omit the region entirely unless startLine >= 1.
- **Proving test:** buildOpenSipSarif([{...sig, code: undefined, filePath: 'a.ts', line: undefined, column: 7}], driver) — assert the result's region is undefined (or has no startColumn), NOT `{ startColumn: 7 }`. Currently it emits `{ startColumn: 7 }`.

#### 23. Load driver issues zero requests for any workload.rps < 10 (and systematically under-delivers all rates) — fractional requests-per-tick are floored and discarded with no carry

- **Status:** 🔴 LIVE · **Severity:** high · **Kind:** bug · **Subsystem:** `simulation` · **Audit confidence:** high
- **Files:** `packages/simulation/engine/src/framework/execution/run-load-window.ts:160`, `packages/simulation/engine/src/framework/execution/run-load-window.ts:53`, `packages/simulation/engine/src/framework/execution/run-load-window.ts:157-168`
- **Code:**
  ```ts
  const TICK_INTERVAL_MS = 100;
  ...
  const requestsThisTick = Math.floor((targetRps * rampUpProgress) / (1000 / TICK_INTERVAL_MS));
  for (let i = 0; i < requestsThisTick; i++) { ... dispatchRequest(state); }
  ```
- **Concern:** Numeric precision / execution determinism / wrong measurement
- **Trigger:** Define a load (or chaos) scenario with workload.rps between 1 and 9 (e.g. `rps: 5`) — a value accepted by validateTargetAndWorkload (only rps>0 required). 1000/TICK_INTERVAL_MS = 10, so requestsThisTick = Math.floor(rps/10) = 0 on EVERY 100ms tick.
- **Expected:** Over the window the driver should issue approximately rps * (windowMs/1000) requests; a low integer rps should still produce a steady stream of requests (e.g. rps=5 → ~1 request every 200ms).
- **Actual:** requestsThisTick is 0 for the entire window when rps<10, so totalRequests stays 0. No accumulator carries the fractional remainder, so even for rps>=10 the per-tick truncation systematically under-delivers the target rate (e.g. rps=25 → floor(2.5)=2/tick = 20 rps actual). With totalRequests===0, resolveMetric returns success_rate=0 and requests_per_second=0, so a `highSuccessRate`/`minThroughput` assertion FAILS for a scenario that simply never ran — a misleading gate verdict — while error_rate=0 makes `lowErrorRate` pass trivially.
- **Why it matters:** A user-authored, validation-passing scenario silently simulates nothing and produces metrics that are either trivially-passing (error rate) or wrongly-failing (success rate / throughput). The empty-run guard in sim.ts only checks scenario COUNT, not whether a scenario issued any requests, so this slips through as a passing/failing run that measured nothing.
- **Recommendation:** Carry the fractional request budget across ticks with an accumulator (e.g. `pending += targetRps*rampUpProgress/(1000/TICK_INTERVAL_MS); const n = Math.floor(pending); pending -= n;`), or shorten the tick / pace per-request by inter-arrival time. At minimum reject rps that cannot produce >=1 request/tick, or document the rps>=10 floor in validation.
- **Proving test:** Unit test: `runLoadWindow({ workload: { rps: 5 } }, ctx(new AbortController().signal), { windowMs: 1000, target: countingTarget() })` and assert `r.metrics.totalRequests > 0` (currently 0). A second test with `rps: 25, windowMs: 1000` should assert totalRequests is within ~10% of 25 (currently lands at ~20 due to floor truncation).

### MEDIUM

#### 24. Display map keys omit the language prefix, so applyCheckDisplay matches nothing — all icons/display names in 5 packs are dead

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `checks-langs` · **Audit confidence:** high
- **Files:** `packages/fitness/checks-rust/src/display/index.ts:10`, `packages/fitness/checks-go/src/display/index.ts:10`, `packages/fitness/checks-java/src/display/index.ts:10`, `packages/fitness/checks-cpp/src/display/index.ts:10`, `packages/fitness/checks-python/src/display/index.ts:10`, `packages/fitness/checks-rust/src/index.ts:8`
- **Code:**
  ```ts
  export const checkDisplay = { 'no-dbg-macro': ['🦀', 'No dbg! Macro'] };  // but slug is 'rust-no-dbg-macro'
  // applyCheckDisplay: const entry = displayMap[check.config.slug]; if (!entry) return check;
  ```
- **Concern:** API contract mismatch / dead configuration — display data silently ignored
- **Trigger:** Run `opensip fit` (or generate a report) against any Python/Go/Java/C++/Rust project that produces a finding. The check renders the default 🔍 icon and a kebab-to-title-case name derived from the prefixed slug instead of the authored display.
- **Expected:** applyCheckDisplay folds the authored [icon, displayName] onto each check: e.g. rust-no-dbg-macro → 🦀 'No dbg! Macro', go-no-fmt-print → 🖨️ 'No fmt.Print', java-no-print-stack-trace → 🧵 'No printStackTrace', cpp-clang-tidy → 🧹 'Clang-Tidy Passthrough', python-no-bare-except → 🐍 'No Bare Except'.
- **Actual:** applyCheckDisplay looks up displayMap[check.config.slug]. The slugs are language-prefixed ('rust-no-dbg-macro', 'go-no-fmt-print', 'java-no-print-stack-trace', 'cpp-clang-tidy', 'python-no-bare-except', 'python-function-too-long') but every display key omits the prefix ('no-dbg-macro', 'no-fmt-print', 'no-print-stack-trace', 'clang-tidy-passthrough', 'no-bare-except'). No key ever matches a slug, so every check passes through unchanged with icon/displayName === undefined. display-registry.ts then falls back to DEFAULT_ICON 🔍 and kebab-cased prefixed slug (e.g. 'Go No Fmt Print'). The python pa…
- **Why it matters:** User-facing CLI and HTML report render the wrong icon and an unintended/ugly display name for every language-pack check. The carefully authored per-language emojis and names are entirely dead. It also signals the slug↔display contract is not enforced, so future language checks will silently inherit the same breakage.
- **Recommendation:** Key the display maps on the real (prefixed) slugs — e.g. 'rust-no-dbg-macro', 'go-no-fmt-print', 'java-no-print-stack-trace', 'cpp-clang-tidy', 'python-no-bare-except' — and add the missing 'python-function-too-long' entry. Then add a test asserting applyCheckDisplay actually set config.icon/config.displayName on the exported `checks` (not just that the map has some key).
- **Proving test:** In each pack: `import { checks } from '../index.js';` then `expect(checks.find(c => c.config.slug === 'rust-no-dbg-macro')?.config.icon).toBe('🦀')`. Currently this returns undefined, proving the fold never happened. After fixing the key to the prefixed slug it returns 🦀.

#### 25. input-sanitization HTML-template-interpolation arm dead under strip-strings: node.head.text is blanked so the leading-`<tag>` test never matches

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `checks-typescript` · **Audit confidence:** high
- **Files:** `packages/fitness/checks-typescript/src/checks/security/input-sanitization.ts:228`, `packages/fitness/checks-typescript/src/checks/security/input-sanitization.ts:196-197`
- **Code:**
  ```ts
  contentFilter: 'strip-strings',
  ...
  if (!ts.isTemplateExpression(node)) return null;
  if (!/^\s*<[a-zA-Z]/.test(node.head.text)) return null;
  ```
- **Concern:** False negative — one of four detection arms never fires
- **Trigger:** `element.innerHTML = `<div>${req.body.name}</div>`` style template, or any HTML template with user input, run through the real CLI.
- **Expected:** Flags unsanitized user input interpolated into an HTML template literal.
- **Actual:** strip-strings blanks the template head content (`<div>` -> spaces), so `node.head.text` no longer starts with `<tag>`; the regex test fails and checkHtmlTemplateInterpolation always returns null. The innerHTML / exec / fs arms still work (identifier-based), but this XSS-in-HTML-template arm is dead in production.
- **Why it matters:** Silently drops a documented XSS detection path (template-literal HTML injection) for every real run.
- **Recommendation:** Read the HTML head from raw source, or switch this check to 'raw' (its other arms are structural/identifier-based and unaffected by raw content; the AST isInStringOrRegex guard already screens pattern-definition false positives).
- **Proving test:** With the TS adapter registered, feed a template `<div>${req.body.x}</div>` assigned to innerHTML and assert the 'HTML template' finding appears. It currently does not.

#### 26. pii-exposure-in-logs: first-PII-field-wins short-circuit hides a later raw PII field when an earlier PII field is safe-wrapped

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `checks-typescript` · **Audit confidence:** high
- **Files:** `packages/fitness/checks-typescript/src/checks/quality/observability/pii-exposure-in-logs.ts:131-158`, `packages/fitness/checks-typescript/src/checks/quality/observability/pii-exposure-in-logs.ts:209-224`
- **Code:**
  ```ts
  if (PII_FIELD_NAMES.has(propName.toLowerCase())) {
    const safe = isWrappedInSafeCall(prop.initializer);
    return { fieldName: propName, safe };
  }
  ```
- **Concern:** False negative — sanitized field masks an adjacent unsanitized PII field
- **Trigger:** `logger.info({ email: hashPii(email), ssn: rawSsn })` — first PII property (email) is safe-wrapped, second (ssn) is raw.
- **Expected:** Flag the raw `ssn` (real PII leak).
- **Actual:** findPiiFieldInObject returns at the FIRST PII field it encounters with its own `safe` flag. Since email is safe, it returns {email, safe:true}; the caller checks `piiField && !piiField.safe` -> false, so no violation and the raw ssn is never inspected. Loop ordering is object-property order.
- **Why it matters:** A real PII-leak compliance check can be defeated by placing a sanitized PII field before an unsanitized one in the same log object.
- **Recommendation:** Collect ALL PII fields (or continue scanning past safe ones) and flag any field where safe===false, instead of returning on the first match. Iterate properties and short-circuit only on the first UNSAFE field.
- **Proving test:** Assert that `logger.info({ email: hashPii(email), ssn: ssn })` yields a finding for ssn. Today it yields none.

#### 27. Meta-check `no-raw-regex-on-code` never fires on the real codebase: wrong path substring

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `checks-universal` · **Audit confidence:** high
- **Files:** `packages/fitness/checks-universal/src/checks/quality/no-raw-regex-on-code.ts:37`
- **Code:**
  ```ts
  // Only analyze fitness check files
  if (!filePath.includes('fitness/src/checks/')) return [];
  ```
- **Concern:** false negative / dead gate (path mismatch with actual repository layout)
- **Trigger:** Run the check against any real check pack file. The check packs live at `packages/fitness/checks-universal/src/checks/...`, `packages/fitness/checks-typescript/src/checks/...`, etc. None of those absolute paths contain the substring `fitness/src/checks/` (it is `fitness/checks-universal/src/checks/` or `fitness/engine/src/...`).
- **Expected:** The advisory meta-check inspects every fitness check source file that uses regex without declaring `contentFilter`.
- **Actual:** `filePath.includes('fitness/src/checks/')` is true ONLY for the check's own crafted fixtures (which were placed under a synthetic `.../fitness/src/checks/` directory). On the actual repo it returns `[]` for every file, so the check is effectively dead — it can never find a real offender. Confirmed via `find ... -path '*fitness/src/checks/*'` matching only the fixtures.
- **Why it matters:** This is a self-dogfooding gate that the team relies on to catch regex-checks missing a content filter (exactly the class of bug behind the CORS finding above). Because the path guard is wrong, that whole guard provides zero coverage on the production check corpus.
- **Recommendation:** Match the real layout, e.g. `filePath.includes('/src/checks/') && /\/(checks-(universal|typescript|python|go|java|cpp|rust)|engine)\//.test(filePath)` (or simply `/checks-[a-z]+\/src\/checks\//`). Add a fixture whose path mirrors the real `checks-*/src/checks/` shape so the test would have caught this.
- **Proving test:** Run `analyze(content, '/abs/packages/fitness/checks-universal/src/checks/security/cors-configuration.ts')` on a check body that uses `.exec(` but omits `contentFilter`. Today returns `[]`; after the fix returns one `missing-content-filter` warning.

#### 28. catch-clause-safety: brace-depth state machine never closes a single-line catch, mis-attributing later `as Error` casts

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `checks-universal` · **Audit confidence:** high
- **Files:** `packages/fitness/checks-universal/src/checks/resilience/catch-clause-safety.ts:38-44`, `packages/fitness/checks-universal/src/checks/resilience/catch-clause-safety.ts:60-89`
- **Code:**
  ```ts
  catchBlockStart = i;
  braceDepth = 0;
  ...
  // Exit catch block when braces close
  if (braceDepth <= 0 && i > catchBlockStart) {
    inCatchBlock = false;
  }
  ```
- **Concern:** invalid state transition (single-line block never exits → stale catch context)
- **Trigger:** A one-line catch such as `} catch (e) { log(e); }`. On that line braceDepth goes 1 then 0, but the exit guard requires `i > catchBlockStart`, which is false on the catch's own line, so `inCatchBlock` stays true. Every subsequent line is then treated as still inside the catch.
- **Expected:** After a single-line catch closes, `inCatchBlock` is false and later code is not attributed to the catch.
- **Actual:** `inCatchBlock` remains true until the NEXT `}` brings depth <= 0 on a later line. Any `as Error` cast on an unrelated subsequent line (before that next closing brace) is reported as an unguarded catch cast — a false positive. The `catchHasInstanceofCheck`/`catchVarName` state is also carried into the wrong region.
- **Why it matters:** Produces spurious `unsafe-error-cast` warnings on code that is not in a catch block, eroding trust in a quality gate (this repo runs fit as a hard PR gate).
- **Recommendation:** Compute brace delta on the catch line itself and exit when depth returns to 0 even on the same line (track whether the body opened), or detect single-line `catch(...){...}` and don't enter block mode. Add a fixture with a single-line catch followed by an unrelated `value as Error`.
- **Proving test:** analyze a file: line1 `try { x() } catch (e) { log(e); }`, line5 `const z = something as Error;` (no catch). Expect zero violations; current code emits an `unsafe-error-cast` on line5.

#### 29. Git-trackable baseline fingerprint export sorts with locale-dependent localeCompare, making the committed JSON non-deterministic across locales/ICU

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `cli-bootstrap` · **Audit confidence:** high
- **Files:** `packages/cli/src/bootstrap/baseline-seams.ts:145-148`
- **Code:**
  ```ts
  const fingerprints = repo
    .load(tool)
    .map((r) => r.fingerprint)
    .sort((a, b) => a.localeCompare(b));
  ```
- **Concern:** Serialization determinism — git-trackable artifact ordering depends on runtime locale
- **Trigger:** Run `opensip graph-baseline-export --out graph-baseline.json` (which calls exportBaselineFingerprints) on two machines/CI runners with different default locales or ICU versions, given fingerprints whose code-point order differs from collation order (mixed-case file paths, leading-underscore/punctuation paths, or multi-digit line numbers). graph's fingerprint is `ruleId|filePath|line|column`, so paths like `src/Foo.ts` vs `src/_util.ts` and lines `1`/`10`/`2` reorder under localeCompare vs code-point sort.
- **Expected:** A byte-preserved, deterministic git-trackable JSON baseline whose array order is identical regardless of the host's locale (the file is meant to be committed and diffed; CLAUDE.md and baseline-strategy.ts call it a 'byte-preserved consumer-repo artifact').
- **Actual:** Array.prototype.sort with String.prototype.localeCompare (no explicit locale) uses the runtime default ICU collation: it case-folds and reorders punctuation/digits differently from code-point order, and the result can vary by `LANG`/ICU version. Demonstrated: ['r|src/Foo.ts|1|0','r|src/_util.ts|1|0','r|src/Foo.ts|10|0','r|src/Foo.ts|2|0'] sorts differently under localeCompare vs code-point `.sort()`. The sibling SARIF formatter (output/src/format/signal-sarif.ts:176) correctly uses plain `.sort()`.
- **Why it matters:** Re-exporting the same baseline on a differently-configured machine produces spurious git diffs and can mislead PR reviewers into thinking the gate baseline changed. It does not affect the ratchet result (set comparison is order-independent), but it undermines the file's purpose as a stable committed artifact.
- **Recommendation:** Sort by code point (locale-independent): `.sort()` or `.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))`, matching signal-sarif.ts. Avoid localeCompare for machine-comparable identifiers.
- **Proving test:** Add a test feeding fingerprints with mixed case and multi-digit lines (e.g. 'r|src/Foo.ts|10|0','r|src/_util.ts|1|0','r|src/foo.ts|2|0') and assert the serialized order equals plain code-point sort; optionally run with a non-English locale env (LC_ALL) to confirm stability.

#### 30. hostPlanes.entitlements.check() silently flips from entitled:true to a record with no `entitled` field once recordUsage() has been called

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `cli-bootstrap` · **Audit confidence:** high
- **Files:** `packages/cli/src/bootstrap/host-planes.ts:137-146`, `packages/cli/src/bootstrap/host-planes.ts:147-155`
- **Code:**
  ```ts
  async check(toolId, _action?) {
    const state = readBlob(toolId, 'entitlements') ?? {};
    if (!state || Object.keys(state).length === 0) {
      return { entitled: true, source: 'default' };
    }
    return state;
  }
  ...
  async recordUsage(toolId, usage) {
    const current = readBlob(toolId, 'entitlements') ?? {};
    writeBlob(toolId, 'entitlements', { ...current, lastUsage: usage, updatedAt: Date.now() });
  }
  ```
- **Concern:** Authorization-affecting state transition: an unrelated write mutates the entitlement-check result
- **Trigger:** Call hostPlanes.entitlements.recordUsage(toolId, ...) (metering) and then hostPlanes.entitlements.check(toolId). recordUsage writes the SAME 'entitlements' key with { lastUsage, updatedAt } (no `entitled` field), so check's empty-state branch no longer applies and it returns that raw record.
- **Expected:** check() should return an entitlement status reflecting actual licensing; recording usage (metering) must not change whether a tool is considered entitled. A permissive OSS default should keep returning entitled:true unless a real un-entitled record was written.
- **Actual:** Before any recordUsage, check returns { entitled: true, source: 'default' }. After a single recordUsage, the stored blob is non-empty so check returns { lastUsage, updatedAt } — which has no `entitled` field, so a consumer reading result.entitled gets undefined (falsy). Metering a usage event effectively de-entitles the tool from check()'s perspective.
- **Why it matters:** If/when a host wires real gating on hostPlanes.entitlements.check (the documented purpose: 'Tools check whether an action is licensed'), recording usage would silently deny subsequent actions. Even as a first-cut placeholder, the read/write share a key with incompatible shapes, which is a latent correctness trap for Cloud's later implementation.
- **Recommendation:** Separate the stored shape from the check result: store usage/license under distinct sub-keys (e.g. state.usage, state.license, state.entitlement) and have check() derive { entitled } from an explicit entitlement field, defaulting to entitled:true only when no explicit un-entitled record exists — not when the blob is merely empty.
- **Proving test:** Unit test: recordUsage(tool, {n:1}); then expect((await check(tool)).entitled).toBe(true). Currently it is undefined.

#### 31. sessions show severity filters drop 'critical'/'low' and mis-rank 'critical' in top:N (relies on unstated 2-level-replay invariant)

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** risk · **Subsystem:** `cli-commands-host` · **Audit confidence:** high
- **Files:** `packages/cli/src/commands/session-show.ts:122-127`, `packages/cli/src/commands/session-show.ts:144-151`, `packages/cli/src/commands/session-show.ts:159-167`
- **Code:**
  ```ts
  function severityRank(severity: string): number {
    if (severity === 'high') return 0;
    if (severity === 'medium') return 1;
    return 2;
  }
  ...
  if (hasErrorsOnly && !hasWarningsOnly) {
    signals = signals.filter((s) => s.severity === 'high');
  } else if (hasWarningsOnly && !hasErrorsOnly) {
    signals = signals.filter((s) => s.severity === 'medium');
  }
  ```
- **Concern:** Severity classification inconsistent with the canonical error/warning rung used everywhere else in the codebase
- **Trigger:** A tool whose SessionReplay reconstructs full 4-level severity (any signal with severity 'critical' or 'low') replayed via `opensip sessions show <id> --filter errors-only` (or --filter top:N).
- **Expected:** `errors-only` returns the error rung = severity in {critical, high} (the canonical definition in @opensip-cli/core isErrorSeverity: `severity === 'critical' || severity === 'high'`, used by graph/sim/fitness payloads and SARIF). `top:N` should rank critical above high.
- **Actual:** `errors-only` filters to `s.severity === 'high'` only, silently dropping every 'critical' finding (the single most severe rung). `warnings-only` filters to `=== 'medium'`, dropping 'low'. severityRank() maps 'critical' to 2 (same bucket as 'low'), so under `top:N` the most severe finding sorts to the BOTTOM. The whole filter set is the only place in the repo that does not use the `critical||high` rung definition.
- **Why it matters:** These `--filter` paths are explicitly the agent-ergonomics surface for token-efficient historical results. Dropping/under-ranking critical findings gives an agent (or human) a filtered view that omits the worst problems while claiming to show 'errors-only'. It works today only because all three first-party tools collapse severity to 2 levels on store and reconstruct only high/medium on replay (fitness/graph/sim session-replay.ts: `finding.severity === 'error' ? 'high' : 'medium'`). The SessionReplay envelope type permits all four SignalSeverity values, and the replay registry is built `fromToo…
- **Recommendation:** Use the canonical rung: import isErrorSeverity from @opensip-cli/core (or inline `s.severity === 'critical' || s.severity === 'high'` for errors-only, and `=== 'medium' || === 'low'` for warnings-only). In severityRank, give 'critical' rank 0 (or -1) and 'low' a distinct rank, e.g. critical=0, high=1, medium=2, low=3.
- **Proving test:** Build a ToolSessionReplay whose envelope.signals = [signal('critical'), signal('high'), signal('medium'), signal('low')]; call executeSessionShow with filters=['errors-only'] and assert the returned envelope contains BOTH the critical and high signals (currently it returns only high). Separately, filters=['top:1'] should return the 'critical' signal, not 'high'.

#### 32. Invalid `--limit` / `--older-than` values exit code 1 (RUNTIME_ERROR) instead of 2 (CONFIGURATION_ERROR)

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `cli-commands-mount` · **Audit confidence:** high
- **Files:** `packages/cli/src/commands/host-subcommand-groups.ts:173-179`, `packages/cli/src/commands/host-subcommand-groups.ts:188-194`
- **Code:**
  ```ts
  function parsePositiveInt(raw: string): number {
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n) || n <= 0) {
      throw new Error(`Invalid --limit value: '${raw}'. Must be a positive integer.`);
    }
    return n;
  }
  ```
- **Concern:** wrong exit code for usage errors (validation parity)
- **Trigger:** `opensip sessions list --limit abc` or `opensip sessions purge --older-than xyz`
- **Expected:** A bad option value is a usage error and must exit 2 (CONFIGURATION_ERROR) — the same code a `choices` rejection yields and the parity error-handler.ts re-maps `commander.invalidOptionArgument` to.
- **Actual:** These argParsers throw a plain `Error`. Verified against commander@15: a plain `Error` thrown from an argParser is NOT wrapped into a `CommanderError`, so error-handler.ts's CommanderError/invalid-argument re-map never fires, `getErrorSuggestion` returns null (the message matches no rule), and the exit code defaults to RUNTIME_ERROR (1). Reproduced end-to-end: `sessions list --limit abc` exits 1, while `sessions list --tool nope` (a choices rejection) correctly exits 2.
- **Why it matters:** Exit-code contract violation. Scripts and CI that distinguish usage errors (2) from runtime failures (1) get the wrong signal; error-handler.ts explicitly documents the intent that invalid-argument-value usage errors map to exit 2 for ValidationError parity. (graph's `--concurrency` parser has the same latent issue, but its root cause is out of scope.)
- **Recommendation:** Throw `new InvalidArgumentError(...)` from `commander` instead of a plain `Error` in both `parsePositiveInt` and `parseOlderThanDays`. Commander wraps that into a `CommanderError` with code `commander.invalidOptionArgument`, which `commanderExitCode` re-maps to CONFIGURATION_ERROR (2).
- **Proving test:** Build the CLI, run `opensip sessions list --limit abc; echo $?` → currently `1`, should be `2`. Add an exit-parity test asserting exit 2 for `--limit abc` and `--older-than xyz`.

#### 33. `tools install --global --project` returns a `tools-uninstall` result (wrong discriminant → renders 'Failed to uninstall')

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `cli-commands-mount` · **Audit confidence:** high
- **Files:** `packages/cli/src/commands/tools/index.ts:127-135`
- **Code:**
  ```ts
  if (opts.global === true && opts.project === true) {
          ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
          return {
            type: 'tools-uninstall',
            target: opts._args[0] ?? '',
            success: false,
            error: '--global and --project are mutually exclusive',
          } satisfies CommandResult;
        }
  ```
- **Concern:** wrong CommandResult discriminant / output contract mismatch
- **Trigger:** `opensip tools install <spec> --global --project` (and `--json` variant)
- **Expected:** The install command's mutual-exclusion error returns a `ToolsInstallResult` (`type: 'tools-install'`), so human output reads 'Failed to install' and the JSON outcome `kind` is `tools-install`.
- **Actual:** It returns a `ToolsUninstallResult` (`type: 'tools-uninstall'`). Reproduced end-to-end: `tools install ./x --global --project --json` emits outcome `kind: 'tools-uninstall'`, `data.type: 'tools-uninstall'`. In human mode result-to-view.ts routes `tools-uninstall` to `viewToolsUninstall`, printing '✗ Failed to uninstall <spec>' — the wrong verb for an install command. The `ToolsInstallResult` required fields (`spec`, `scope`, `validation`) are also absent.
- **Why it matters:** User-facing wrong message and a machine-output contract violation: agents keying on `data.type`/`kind` to dispatch on which command ran see 'tools-uninstall' for an install invocation. `satisfies CommandResult` passes only because ToolsUninstallResult is a valid union member, masking the mistake at compile time.
- **Recommendation:** Return a `ToolsInstallResult`-shaped failure: `{ type: 'tools-install', spec: opts._args[0] ?? '', success: false, scope: 'global', validation: <empty/failed validation>, error: '--global and --project are mutually exclusive' }` (or restructure the validation field as the contract requires).
- **Proving test:** Run `opensip tools install x --global --project --json` and assert `data.type === 'tools-install'` (currently `'tools-uninstall'`). Add a unit test on buildToolsInstallSpec's handler asserting the returned result's `type`.

#### 34. No test asserts the meter provider is globally registered or that metrics record (gap that masks the dropped-metrics bug)

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** risk · **Subsystem:** `cli-misc` · **Audit confidence:** high
- **Files:** `packages/cli/src/telemetry/__tests__/sdk-init.test.ts:33-77`
- **Code:**
  ```ts
  function spanIsRecording(): boolean { ... }
  // ...tests assert spanIsRecording() === true after init, but there is no
  // meterIsRecording()/counter-records equivalent for the MeterProvider.
  ```
- **Concern:** Test gap around critical observability behavior
- **Trigger:** The suite verifies tracing registration (spanIsRecording) but has no analogous assertion for metrics; no test in the repo references getMeter/MeterProvider/metric export. This is exactly why the missing setGlobalMeterProvider went unnoticed.
- **Expected:** A test analogous to spanIsRecording() that proves metrics emitted via core getMeter reach the SDK MeterProvider when the OTLP endpoint is set.
- **Actual:** Metrics registration is entirely untested, so the Phase-2 metrics path (commands.started counter, command.duration_ms histogram) is unverified end to end.
- **Why it matters:** Without the test, the metrics half of telemetry can silently break (and currently is broken) on any refactor; observability data integrity has no guardrail.
- **Recommendation:** Add a test attaching an InMemoryMetricReader (or asserting metrics.getMeterProvider() is the SDK provider) after initTelemetry with the endpoint set; record via getMeter('opensip-cli').createCounter(...).add(1) and assert it is collected. This both fixes the gap and would fail today, surfacing the registration bug.
- **Proving test:** metrics-records test: set OTEL endpoint, init, create+increment a counter through core getMeter, force a collect, assert the data point is present.

#### 35. readGlobalConfig can return a non-object scalar, crashing `opensip configure`

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `config` · **Audit confidence:** high
- **Files:** `packages/config/src/document/global-config.ts:78-86`
- **Code:**
  ```ts
  export function readGlobalConfig(): GlobalConfig {
    if (!existsSync(GLOBAL_CONFIG_PATH)) return {};
    try {
      const raw = readFileSync(GLOBAL_CONFIG_PATH, 'utf8');
      return (parseYaml(raw) as GlobalConfig) ?? {};
    } catch {
      return {};
    }
  }
  ```
- **Concern:** Bad validation / API contract mismatch (return type lies; documented '{} on any failure' violated)
- **Trigger:** `~/.opensip-cli/config.yml` contains a YAML scalar or list rather than a mapping — e.g. a single word `foo` (parses to the string "foo"), `42` (number), `true`, or a top-level YAML list. This can happen from a hand-edit, a truncated/partial write from a tool that wrote the wrong shape, or copy-paste error.
- **Expected:** Per the JSDoc ('Returns `{}` on any failure ... the merge step treats absence and corruption the same') and the declared `GlobalConfig` (object) return type, a non-mapping file should yield `{}`.
- **Actual:** `parseYaml('foo')` returns the string "foo"; the `?? {}` guard only catches null/undefined, so `readGlobalConfig()` returns the scalar typed (falsely) as `GlobalConfig`. In `executeConfigure` (packages/cli/src/commands/configure.ts:85,99) this object is then mutated: `existing.apiKey = key`. Assigning a property to a string/number/boolean primitive in ESM strict mode throws `TypeError: Cannot create property 'apiKey' on string 'foo'`, aborting `configure` with an unhandled crash instead of overwriting the corrupt file.
- **Why it matters:** The documented contract is that corruption is tolerated identically to absence; instead a corrupt-shaped global config makes `opensip configure` (the API-key setup flow) unrecoverable from within the tool. `resolveApiKey`/`readUserCloudConfig` survive (property reads on a primitive yield undefined), but the write path crashes.
- **Recommendation:** Guard the parsed value to a plain object before returning: `const parsed = parseYaml(raw); return (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) ? (parsed as GlobalConfig) : {};` (reuse the existing isPlainObject-style guard used elsewhere in this package).
- **Proving test:** Write `config.yml` containing only `just-a-string` (then separately `42`, then a YAML list), call readGlobalConfig() and assert it returns `{}`. Add a configure-flow test that writes a scalar config then runs executeConfigure() and asserts it does not throw.

#### 36. enterScope JSDoc claims 'Throws on misuse' but the implementation silently replaces the current scope

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** risk · **Subsystem:** `core-lib` · **Audit confidence:** high
- **Files:** `packages/core/src/lib/run-scope.ts:236-247`
- **Code:**
  ```ts
  /* ... Throws on misuse: an existing scope must NOT be
   * replaced silently (call `runWithScope` for nested scopes).
   */
  export function enterScope(scope: RunScope): void {
    scopeStorage.enterWith(scope);
  }
  ```
- **Concern:** API contract mismatch — documented invariant not enforced; scope isolation can be silently broken
- **Trigger:** Calling enterScope twice within the same async context (e.g. a second pre-action hook, a re-entrant command, or a host that reuses an async execution context across runs).
- **Expected:** Per the JSDoc and the CLAUDE.md scope-hygiene invariants (hard guards on scope misuse), a second enterScope on an already-bound context should throw rather than silently swap the active scope.
- **Actual:** enterScope unconditionally calls AsyncLocalStorage.enterWith(scope), which silently replaces the current store with no guard, no check for an existing scope, and no throw. The documented 'Throws on misuse' behavior does not exist. A double-enter (or a host that doesn't fully isolate async contexts) silently rebinds currentScope() for the rest of the async chain, so library code reading currentScope()?.datastore / ?.toolConfig / ?.runId can observe a different run's scope — a cross-run state-bleed hazard the scope design exists to prevent.
- **Why it matters:** The entire no-module-singleton / RunScope design rests on per-run scope isolation. A silently-replacing enterScope that claims to throw lulls callers into assuming the kernel guards against accidental scope clobbering; in a concurrent SaaS host it can leak one run's datastore/config/runId into another with no error surfaced.
- **Recommendation:** Either implement the documented guard (throw a SystemError, e.g. code 'SYSTEM.SCOPE.ALREADY_ENTERED', when currentScope() !== undefined and the incoming scope differs), or correct the JSDoc to state that enterWith silently replaces and that callers must guarantee single-enter per async context. Given the global preference for strong guardrails, the guard is preferable.
- **Proving test:** runWithScope(new RunScope({}), async () => { enterScope(new RunScope({ runId:'a' })); enterScope(new RunScope({ runId:'b' })); }) — assert the second call throws (after fix) instead of silently leaving currentScope()?.runId === 'b'.

#### 37. Declared-but-uninstalled npm plugins are rejected with a misleading security WARN, and have no clear "not installed" diagnostic

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `core-plugins` · **Audit confidence:** high
- **Files:** `packages/core/src/plugins/discover.ts:180-188`, `packages/core/src/lib/paths.ts:189-200`
- **Code:**
  ```ts
  const packageDir = join(nodeModulesDir, name);
  // Containment check: the resolved real path (after symlinks) must
  // stay inside node_modules. Catches symlink-based escapes ...
  if (!isPathInside(packageDir, nodeModulesDir)) {
    logger.warn({ ..., reason: 'package path resolves outside node_modules', name });
    continue;
  }
  ```
- **Concern:** Misleading/incorrect error handling; observability of a common misconfiguration
- **Trigger:** A project lists a package in `plugins.fit: [...]` in opensip-cli.config.yml but never runs `opensip plugin add` / `npm install` for it, so `<runtime>/plugins/fit/node_modules/<name>` does not exist. (Verified: `realpathSync` on a non-existent path throws ENOENT.)
- **Expected:** The package is skipped with a clear diagnostic like "configured plugin '<name>' is not installed — run 'opensip plugin add'" (mirroring capability-discovery's `capability.discovery.package_not_resolved`).
- **Actual:** `isPathInside(packageDir, nodeModulesDir)` calls `realpathSync(packageDir)`, which throws ENOENT for the missing dir, so `isPathInside` returns false and the code logs a WARN-level `plugin.loader.discover.reject` with reason `package path resolves outside node_modules` — a security-toned message for an ordinary "forgot to install" case. There is NO separate "not installed" diagnostic anywhere on this path (`tryDiscoverPackage`'s `safeIsDirectory` skip is never reached, and even it is silent). The user cannot tell why their declared plugin didn't load.
- **Why it matters:** This is the exact "where did this check come from?" failure mode the discovery design says it wants to avoid, in reverse: a missing-but-declared plugin silently fails to register checks, and the only log is a confusing path-escape warning. Operators chasing a green-but-empty run get pointed at a fake security issue instead of the real cause.
- **Recommendation:** Probe existence before the containment check: if `!existsSync(packageDir)` (or `!safeIsDirectory(packageDir)`), emit a `plugin.loader.discover.not_installed` diagnostic and `continue`. Only run `isPathInside` for an existing path (where a false result genuinely means a symlink escape). Reorder so the security WARN fires only for paths that actually resolve outside node_modules.
- **Proving test:** Unit test: declare `plugins.fit: ['ghost']` with no `ghost` installed; spy on `logger`. Assert discovery returns `[]` AND that the emitted diagnostic reason is "not installed" (NOT "package path resolves outside node_modules"). The existing test at discover.test.ts:189 only asserts `[]`, so it does not catch this.

#### 38. setRegistrar does not enforce that the caller owns the domain — a non-owning tool can hijack another tool's capability registrar

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** risk · **Subsystem:** `core-plugins` · **Audit confidence:** medium
- **Files:** `packages/core/src/plugins/capability-registry.ts:149-167`, `packages/cli/src/bootstrap/config-and-capabilities.ts:267-275`
- **Code:**
  ```ts
  setRegistrar(domainId: string, registrar: CapabilityRegistrar): void {
    const entry = this.domains.get(domainId);
    if (entry === undefined) { throw new UnknownCapabilityDomainError(...); }
    // Replace the registrar; keep the manifest-declared spec verbatim.
    this.domains.set(domainId, { spec: entry.spec, registrar });
  ```
- **Concern:** Unenforced ownership invariant / invalid state transition
- **Trigger:** Two installed tools both ship a `capabilityRegistrars` entry for the same domain id (e.g. a malicious or buggy third-party tool declares a registrar for the first-party `fit-recipe` / `fit-pack` domain). `registerDomain` is first-writer-wins on the SPEC (so `ownerToolId` is fixed to tool A), but `wireCapabilityRegistry` calls `registry.setRegistrar(domainId, registrar)` for EVERY tool whose registrars map contains a `hasDomain(domainId)` id — gated only by `hasDomain`, not by `spec.ownerToolId === tool.metadata.id`.
- **Expected:** Only the tool whose `metadata.id` equals `spec.ownerToolId` can wire/replace a domain's registrar. The JSDoc states: "Only the owning tool should call this (the host routes by `ownerToolId`)."
- **Actual:** `setRegistrar` overwrites the registrar unconditionally; the host wiring loop iterates `tools.list()` order and the LAST tool declaring a colliding registrar wins. Contributions to that domain are then routed to a non-owner's registrar. The documented invariant ("the host routes by `ownerToolId`") is enforced nowhere — the host routes by `hasDomain`.
- **Why it matters:** Cross-tool registrar hijacking: a third-party tool could intercept first-party check/recipe contributions, or simply break a tool by replacing its registrar with an incompatible one. Even absent malice, it makes load order load-bearing and silently non-deterministic.
- **Recommendation:** Add an `expectedOwnerToolId` parameter to `setRegistrar` and throw (or no-op + warn) when it does not match `entry.spec.ownerToolId`; have `wireCapabilityRegistry` pass `tool.metadata.id` and only wire registrars for domains the tool actually owns (`spec.ownerToolId === tool.metadata.id`), not merely `hasDomain`.
- **Proving test:** Register domain `d` from tool A's manifest (ownerToolId A). Wire registrars where tool B (id B) also declares a registrar for `d`. Assert that routing a contribution to `d` reaches A's registrar, not B's — currently it reaches whichever was wired last.

#### 39. dispatchOutput silently drops all output for an unrecognized CommandSpec.output, and defineCommand never validates the output/scope enums

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `core-tools` · **Audit confidence:** high
- **Files:** `packages/core/src/tools/command-spec.ts:257-286`, `packages/core/src/tools/command-spec.ts:152`
- **Code:**
  ```ts
  export function defineCommand<TOpts = unknown, TCtx = CommandContext>(
    spec: CommandSpec<TOpts, TCtx>,
  ): CommandSpec<TOpts, TCtx> {
    if (spec.name.trim() === '') { ... }
    ...
    validateRawStreamDeclaration(spec);
    const seen = new Set<CommonFlagKey>();
    for (const key of spec.commonFlags) { ... }
    return spec;
  }
  ```
- **Concern:** Bad validation / silent failure on invalid state
- **Trigger:** A tool ships a command whose `output` is not one of `signal-envelope|command-result|raw-stream|live-view` — e.g. a JS/.mjs plugin object, a typo, or a tool built against a newer contract that added an output mode this engine doesn't know. (Plugin commandSpecs are read raw from `tool.commandSpecs` and mounted directly — register-tools.ts:839 — they are never re-run through `defineCommand`.)
- **Expected:** An invalid `output` should be rejected loudly — either at construction (defineCommand) or at mount/dispatch — the same way `rawStreamReason` and unknown `commonFlags` are rejected, so a mis-declared command fails fast rather than producing no output.
- **Actual:** `defineCommand` validates name/description/handler/rawStreamReason/commonFlags but never validates that `output` ∈ CommandOutputMode (nor that `scope` ∈ CommandScopeRequirement). Downstream, `dispatchOutput` (packages/cli/src/commands/mount-command-spec.ts:185-230) is a `switch (spec.output)` with NO `default` case: an unrecognized value matches nothing, the function returns void, and the handler's computed result is silently discarded (no render, no JSON, no error, exit 0).
- **Why it matters:** A run can complete 'successfully' (exit 0) while emitting zero output for the user — the worst kind of silent failure for an analysis CLI whose entire value is its findings. It also means the engine cannot safely evolve CommandOutputMode without older engines silently swallowing new-mode commands.
- **Recommendation:** Add an `output`/`scope` membership check to `defineCommand` (mirroring the COMMON_FLAG_KEYS/RAW_STREAM_REASONS pattern), AND add a `default:` arm to `dispatchOutput` that throws a loud Error (mis-declared spec) — defense in depth, since plugins may bypass defineCommand. The two together make an invalid output impossible to swallow silently.
- **Proving test:** Construct `{ ...validSpec, output: 'bogus' as CommandOutputMode }`, mount it, and invoke its action with a handler returning a CommandResult; assert that nothing is written to stdout and exit code stays 0 (proves the silent drop). After the fix: assert defineCommand throws, and dispatchOutput throws for the bogus mode.

#### 40. isModernShape UUID heuristic is over-broad and the human-key fallback can mask a real manifest⇔tool drift

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** risk · **Subsystem:** `core-tools` · **Audit confidence:** medium
- **Files:** `packages/core/src/tools/manifest-assert.ts:43-51`
- **Code:**
  ```ts
  const isModernShape =
    typeof tool.metadata.id === 'string' && /^[0-9a-fA-F]{8}-/.test(tool.metadata.id);
  const runtimeHuman = isModernShape && tool.metadata.name ? tool.metadata.name : tool.metadata.id;
  
  if (manifest.id !== runtimeHuman) {
    throw new ValidationError( ... );
  }
  ```
- **Concern:** Weak validation / id-shape detection that can flip the comparison target
- **Trigger:** (1) A modern tool sets a real UUID `metadata.id` but an empty `metadata.name` (`name: ''`): `isModernShape && tool.metadata.name` is falsy, so `runtimeHuman` silently falls back to the UUID, and the drift guard then compares `manifest.id` (human key, e.g. 'fitness') against the UUID — throwing a confusing 'does not match runtime tool name <UUID>' even though the only fault is an empty name. (2) A non-UUID `metadata.id` that happens to begin with 8 hex chars + '-' (e.g. `'deadbeef-internal'`) is misclassified as modern.
- **Expected:** The drift guard should compare like-for-like: the manifest human `id` against the runtime human key, with a clear, correct error when the name is missing, and a robust id-shape test (full UUID, not just an 8-hex-prefix).
- **Actual:** The shape test only checks the first 8 hex chars + a dash (`/^[0-9a-fA-F]{8}-/`), not a full UUID; and when `metadata.name` is empty/missing the guard silently compares against the UUID, producing a misleading error message and conflating 'empty name' with 'name mismatch'.
- **Why it matters:** manifest-assert is a load-time gate that fails-closed for bundled/authored tools (exit 5). A false or misleading failure blocks the whole CLI; a misclassification could also let the human-key comparison target the wrong field. The error text 'runtime tool name <uuid>' is actively misleading for diagnosis.
- **Recommendation:** Use a full UUID regex (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`) for the modern-shape test, and treat a modern-shape tool with an empty `metadata.name` as an explicit error ('modern tool must declare a non-empty metadata.name') rather than silently falling back to the UUID.
- **Proving test:** Call `assertManifestMatchesTool(makeManifest('fitness',['fit'], uuid), makeTool('', ['fit'], uuid))` (empty human name, modern UUID id) and observe the thrown message references the UUID as 'runtime tool name' — a misleading diagnosis. Add a case `metadata.id='deadbeef-x'` to show the 8-hex heuristic misclassifies it as modern.

#### 41. FingerprintStrategy returning an empty string yields a signal the baseline plane treats as unstamped (hard throw), and stampFingerprints never converges

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** risk · **Subsystem:** `core-tools` · **Audit confidence:** high
- **Files:** `packages/core/src/baseline/fingerprint-strategy.ts:24`, `packages/core/src/baseline/fingerprint-strategy.ts:49-57`
- **Code:**
  ```ts
  export type FingerprintStrategy = (signal: Signal) => string;
  ...
  export function stampFingerprints(
    signals: readonly Signal[],
    strategy: FingerprintStrategy,
  ): readonly Signal[] {
    if (signals.every((signal) => signal.fingerprint)) return signals;
    return signals.map((signal) =>
      signal.fingerprint ? signal : { ...signal, fingerprint: strategy(signal) },
    );
  }
  ```
- **Concern:** Contract weakness / serialization-identity invariant not enforced
- **Trigger:** A tool declares a custom `Tool.fingerprintStrategy` that can return '' for some signal (e.g. a strategy that joins fields that are all empty, or returns '' as a sentinel).
- **Expected:** A `FingerprintStrategy` is the baseline identity primitive; stamping should either guarantee a non-empty identity or reject an empty one with a clear contract error at the source, not let an empty identity flow into the envelope.
- **Actual:** stampFingerprints uses truthiness (`signal.fingerprint ?`), so a strategy returning '' produces `fingerprint: ''`. On any re-stamp the `.every(...)` truthiness check is false and `.map` re-derives '' again (never converges to 'stamped'). The host seam `requireStampedEntries` (packages/cli/src/bootstrap/baseline-seams.ts:58, `if (!s.fingerprint) throw`) then throws 'signal X is not fingerprint-stamped' at `--gate-save`, even though stampFingerprints 'ran'. The failure surfaces far from the root cause (the strategy), and the type `() => string` advertises empty as legal.
- **Why it matters:** A consumer-repo CI gate (`--gate-save`/`--gate-compare`) hard-fails with a confusing 'not fingerprint-stamped' error for a strategy that the type system says is valid. The empty-string identity also silently means 'no identity', which would collapse distinct findings to one fingerprint if the truthiness checks were ever loosened — a latent baseline-correctness footgun.
- **Recommendation:** Tighten the contract: have stampFingerprints assert the strategy result is a non-empty string (throw a clear ValidationError naming the offending ruleId at stamp time), or define FingerprintStrategy to forbid empty results and validate it once. This moves the failure to the actual root cause and prevents an empty identity from ever entering an envelope.
- **Proving test:** `stampFingerprints([sig()], () => '')` then feed the result to a save path: today the signal carries `fingerprint:''` and `requireStampedEntries` throws 'not fingerprint-stamped'. After the fix, stampFingerprints itself throws a clear 'strategy returned empty fingerprint for rule-x' error.

#### 42. paginateGroupedRows never restores an expander row's inline display when it re-enters the visible page, so expanded findings vanish after a page round-trip or re-sort

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `dashboard` · **Audit confidence:** high
- **Files:** `packages/dashboard/src/shared/pagination.ts:86-95`, `packages/dashboard/src/shared/sortable.ts:84-90`, `packages/dashboard/src/sessions.ts:178-181`
- **Code:**
  ```ts
  group.forEach(row => {
    if (row.classList.contains('expander-row')) {
      row.dataset.paged = visible ? 'yes' : 'no';
      if (!visible) row.style.display = 'none';
    } else {
      row.style.display = visible ? '' : 'none';
    }
  });
  ```
- **Concern:** stale-data / cache-consistency: DOM display state is set asymmetrically — data rows are always reset, expander rows only force-hidden, never un-hidden.
- **Trigger:** In a session detail table (or any grouped table) with >10 checks: (1) click a check row with findings to expand it (the click handler sets inline `exp.style.display='table-row'` and adds the `.open` class); (2) page forward (the group leaves the window, so paginateGroupedRows sets inline `style.display='none'` on the expander); (3) page back to the original page. The expander still has the `.open` class and a ▼ arrow, but the inline `display:none` set in step 2 is never cleared, and inline style overrides the CSS rule `.expander-row.open { display: table-row; }`.
- **Expected:** When a previously-expanded group becomes visible again, its expander row should display according to its open/closed state (i.e. visible if `.open`).
- **Actual:** The expander row stays hidden (inline `display:none` wins over `.expander-row.open`), so the findings the user expanded silently disappear; the arrow still shows ▼ as if open. The same root cause strands an expanded row when `makeSortable` re-runs `paginateGroupedRows` after a column sort (sortable.ts:86).
- **Why it matters:** The expander rows hold the actual finding detail (file, message, severity, suggestion). Losing them on a page/sort round-trip hides real findings from the report reader and desyncs the arrow indicator from the visible state — a correctness/data-visibility defect in the report's primary detail surface.
- **Recommendation:** In the expander branch, restore display when the group is visible based on its open state, e.g. `row.style.display = visible ? (row.classList.contains('open') ? 'table-row' : 'none') : 'none';` (or clear the inline style and let CSS govern: `if (visible) row.style.removeProperty('display'); else row.style.display='none';`).
- **Proving test:** jsdom test: build a tbody with 12 data rows each followed by an `.expander-row`; call paginateGroupedRows(tbody, pag, 10); add `.open` class + `style.display='table-row'` to the first expander; click Next then Prev; assert the first expander's effective display is 'table-row' (currently it is the stale inline 'none', i.e. hidden).

#### 43. ToolStateRepo: a stored JSON `null` payload is lost on read (round-trips to undefined, indistinguishable from 'never put')

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `datastore` · **Audit confidence:** high
- **Files:** `packages/datastore/src/tool-state-repo.ts:32-40`
- **Code:**
  ```ts
  get(tool: string, key: string): unknown {
    const row = this.datastore.db
      .select({ payload: toolState.payload })
      ...
      .get();
    return row?.payload ?? undefined;
  }
  ```
- **Concern:** Ser/deser round-trip correctness; API contract mismatch on the documented `cli.toolState` seam (payload type is `unknown`, which includes `null`).
- **Trigger:** A tool calls `cli.toolState.put(tool, key, null)` (legal: the seam type is `payload: unknown`). The JSON column stores the text 'null'; Drizzle reads it back via JSON.parse('null') => JS `null`. `get` then does `null ?? undefined` => `undefined`.
- **Expected:** After `put(tool,key,null)`, `get(tool,key)` returns `null` (a stored value), and the key is distinguishable from a never-put key (which is also `undefined`). The repo JSDoc explicitly promises 'undefined when the key has never been put'.
- **Actual:** `get` returns `undefined` for a key whose stored value is `null`, identical to a never-put key — even though `list(tool)` still reports the key as present. A tool that stores `null` as a meaningful sentinel (e.g. 'cursor explicitly reset') silently loses that value.
- **Why it matters:** Silent data loss / contract violation across the host-owned state plane (ADR-0042). The `??` coalesces a legitimately-stored `null` into the 'absent' signal, breaking the put/get round-trip invariant the seam advertises.
- **Recommendation:** Distinguish absence from a stored null: return `row === undefined ? undefined : (row.payload as unknown)` so a stored `null` round-trips as `null`. (Note `mapResultRow` maps SQL NULL to JS null without JSON.parse, and JSON `null` round-trips to JS null, so `row.payload` is the faithful value.)
- **Proving test:** repo.put('t','k', null); expect(repo.get('t','k')).toBeNull(); expect(repo.list('t')).toEqual(['k']); — today get() returns undefined while list() shows the key, proving the round-trip loss.

#### 44. Version guard counts journal entries but migrate() applies by timestamp — divergence stamps a partially-migrated DB as fully current

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** risk · **Subsystem:** `datastore` · **Audit confidence:** high
- **Files:** `packages/datastore/src/schema-version.ts:33-47`, `packages/datastore/src/factory.ts:57-75`
- **Code:**
  ```ts
  return Array.isArray(parsed.entries) ? parsed.entries.length : undefined;
  ```
- **Concern:** Cache-consistency / invalid state stamp: the supported-version metric (journal entry COUNT) is not the same selector Drizzle uses to decide which migrations to apply (the per-migration `when`/folderMillis TIMESTAMP).
- **Trigger:** Drizzle's better-sqlite3 migrator applies every migration whose `folderMillis` (journal `when`) is strictly greater than the last-applied `created_at` (drizzle-orm/sqlite-core/dialect.cjs:677-686). If a newly added migration's `when` is NOT greater than the previous entry's `when` (hand-edited journal, clock skew, or a regenerated round-number timestamp — note 0009 already uses the hand-written `1781290000000`), migrate() SKIPS it while `readSupportedDbVersion` still counts it.
- **Expected:** supportedVersion reflects the schema migrate() will actually bring a DB to, and the post-migrate `writeUserVersion(supportedVersion)` stamp means 'all these columns/tables exist'.
- **Actual:** On such a journal, migrate() leaves the DB missing the skipped migration's columns, yet factory.ts:75 stamps `user_version = entries.length`. The downgrade guard then treats the DB as fully current on later opens (dbVersion <= supportedVersion), and later queries hit missing columns with a confusing runtime error — the precise failure mode the guard's JSDoc claims to prevent.
- **Why it matters:** A latent schema-corruption trap: the count-based version is only coincidentally aligned with the timestamp-based applied set today (the journal `when` values happen to be monotonic). Any future migration with a non-monotonic timestamp silently desynchronizes the stamp from reality.
- **Recommendation:** Either validate at startup that journal `when` values are strictly increasing (fail fast otherwise), or derive supportedVersion from the same selector migrate() uses (max folderMillis), or stamp `user_version` only after confirming the journal is monotonic. Add a test that a non-monotonic `when` is rejected.
- **Proving test:** Add a unit test asserting the bundled journal's `entries[i].when` is strictly increasing; and a regression test that feeds migrate() a journal where 000N.when < 000(N-1).when and confirms the factory does NOT stamp the DB as current.

#### 45. Migration 0009 has a journal entry and .sql but no meta/0009_snapshot.json — next drizzle-kit generate will diff against the stale 0008 snapshot

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** risk · **Subsystem:** `datastore` · **Audit confidence:** high
- **Files:** `packages/datastore/migrations/meta/_journal.json:68-74`, `packages/datastore/migrations/0009_stable_tool_identity.sql:1-9`
- **Code:**
  ```ts
  { "idx": 9, "version": "6", "when": 1781290000000, "tag": "0009_stable_tool_identity", "breakpoints": true }
  ```
- **Concern:** Migration tooling integrity: drizzle-kit derives each new migration by diffing the current schema against the latest committed `meta/000N_snapshot.json`. The snapshot for 0009 is absent (latest present is 0008_snapshot.json).
- **Trigger:** A developer runs `drizzle-kit generate` to author migration 0010. drizzle-kit loads the highest-numbered snapshot it can find (0008) as the 'previous' state, so the generated 0010 diff is computed against a schema that predates the 0009 `stable_id` columns.
- **Expected:** Every committed migration has its corresponding `meta/000N_snapshot.json` so the migration chain regenerates correctly.
- **Actual:** 0009 added three `stable_id` columns but committed no snapshot, so the next generated migration will be computed against the pre-0009 schema — likely re-adding `stable_id` columns (ALTER on existing columns => runtime migrate failure) or producing an otherwise-corrupt diff.
- **Why it matters:** Runtime migrate() is unaffected (it only reads the journal + .sql), but the dev-time migration-authoring workflow is silently broken; a future contributor gets a wrong/failing migration with no obvious cause.
- **Recommendation:** Regenerate and commit `packages/datastore/migrations/meta/0009_snapshot.json` (re-run drizzle-kit to recreate it from 0008 + 0009.sql), and add a CI check that `meta/000N_snapshot.json` exists for every journal entry.
- **Proving test:** CI assertion: for each entry in meta/_journal.json, assert `meta/<zero-padded-idx>_snapshot.json` exists. Today idx 9 fails.

#### 46. fitness reads `failOnDegraded` from its config namespace, but the namespace schema omits it — setting it is strict-rejected, making the ratchet-as-report opt-out unreachable

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `fit-cli-gate` · **Audit confidence:** high
- **Files:** `packages/fitness/engine/src/config/fitness-config-schema.ts:36-67`, `packages/fitness/engine/src/cli/fit-modes.ts:282-287`
- **Code:**
  ```ts
  // fit-modes.ts (gate-compare):
  await deliverFitSignals(cli, envelope, args, result.degraded && resolveFailOnDegraded('fitness'));
  
  // fitness-config-schema.ts — FitnessNamespaceSchema declares failOnErrors/failOnWarnings/
  // disabledChecks/recipe/defaultTarget/maxParallel/timeout, but NOT failOnDegraded;
  // and env: only OPENSIP_FIT_FAIL_ON_ERRORS / OPENSIP_FIT_FAIL_ON_WARNINGS.
  ```
- **Concern:** API/contract mismatch: a consumed config key is never admitted; documented opt-out is impossible
- **Trigger:** User sets `fitness: { failOnDegraded: false }` in opensip-cli.config.yml to run `fit --gate-compare` in report-only mode (per CLAUDE.md / ADR-0036's "default true -> ratchet-as-report when false").
- **Expected:** `failOnDegraded: false` makes gate-compare print the diff and exit 0 even when degraded (documented ADR-0036 reserved gate key, third beside failOnErrors/failOnWarnings).
- **Actual:** The composer (packages/config/src/composer.ts:47-52) applies `.strict()` to each namespace schema. Since `FitnessNamespaceSchema` has no `failOnDegraded` field, the strict validation in `composeAndValidateToolConfig` (config-and-capabilities.ts:174-177) rejects the document with CONFIGURATION_ERROR before dispatch. There is also no env binding and no `--gate-report-only` flag, so `resolveFailOnDegraded('fitness')` can ONLY ever return the default `true`. The fitness gate-compare ratchet always hard-fails on net-new and cannot be put in report-only mode.
- **Why it matters:** Adopters with a backlog who want net-new annotation without breaking CI (the explicitly documented `failOnDegraded:false` / ratchet-only path) cannot enable it for fitness; their only escape is disabling the gate entirely. The tool consumes a config key it refuses to accept — an internally inconsistent contract.
- **Recommendation:** Add `failOnDegraded: z.boolean().optional()` to `FitnessNamespaceSchema` (and ideally an env binding + the equivalent for graph's namespace, which has the same gap). Confirm `resolveFailOnDegraded` then reads it.
- **Proving test:** With a `fitness: { failOnDegraded: false }` config and a saved baseline, run `fit --gate-compare` against a tree with a net-new finding. Expected: exit 0 with the DEGRADED diff printed. Actual today: the run aborts at config validation with CONFIGURATION_ERROR (`Invalid configuration: fitness: Unrecognized key(s)`). A unit test parsing that document through `composeConfigSchema([fitnessConfigDeclaration])` reproduces the rejection.

#### 47. Fitness fingerprint `sha256(filePath\nruleId\nmessage)` collapses multiple same-message findings in one file — net-new occurrences with an identical message are classified `unchanged`, so the gate ratchet misses them

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** risk · **Subsystem:** `fit-cli-gate` · **Audit confidence:** high
- **Files:** `packages/fitness/engine/src/baseline-strategy.ts:24-25`, `packages/output/src/format/baseline-diff.ts:93-115`
- **Code:**
  ```ts
  export const fitnessFingerprintStrategy: FingerprintStrategy = (s) =>
    createHash('sha256').update(`${s.filePath}
  ${s.ruleId}
  ${s.message}`).digest('hex');
  
  // diffBaseline keys current signals into Map<fingerprint, Signal> (de-dupes):
  for (const signal of current) { ...; currentByFp.set(signal.fingerprint, signal); }
  ```
- **Concern:** Stale/insufficient gate decision: per-occurrence net-new findings masked by fingerprint collision
- **Trigger:** A file `a.ts` has a finding with a fixed message M (e.g. "Avoid `any`") at line 5, recorded in the baseline. A contributor removes that occurrence and adds a brand-new occurrence of the SAME message at line 50 (very common — most checks emit a constant per-violation message).
- **Expected:** A net-new violation appears, so the ratchet should report DEGRADED (or at least track the count change).
- **Actual:** Both occurrences hash to the same fingerprint (line/column excluded). In `diffBaseline` the new occurrence lands in `unchanged` (fingerprint already in baseline), `added=[]`, `degraded=false`. The gate passes. Equivalently, baseline `save` (baseline-repo.ts byFingerprint Map + composite PK `(tool,fingerprint)`) stores only ONE row for N same-message findings, so occurrence counts are invisible to the ratchet. This is the documented "line-shift tolerance" (baseline-plane.test.ts:74-78 pins it intentionally), but its consequence is stronger than line-shift: it is per-file, per-message occurrence…
- **Why it matters:** `fit --gate-compare` is the CI ratchet that's supposed to surface net-new regressions; a whole class of net-new findings (same rule+file+message, different line) is silently absorbed. The masking is invisible — no warning that multiple raw violations collapsed to one baseline key.
- **Recommendation:** This is a deliberate design tradeoff, so treat as a hardening decision: either (a) document the occurrence-count blindness prominently next to the strategy and in the gate docs, or (b) include an occurrence-discriminator (e.g. an intra-file occurrence ordinal, or a normalized code-context snippet) in the hash so distinct occurrences key distinctly while still tolerating pure line shifts. If (a), add a test asserting the known-masking behavior so any future change is intentional.
- **Proving test:** Baseline a run with one `{filePath:'a.ts', ruleId:'no-any', message:'Avoid any', line:5}` finding. Compare against a current run with TWO findings sharing that rule+file+message at lines 50 and 80. Assert the (current) result: `added=[]`, `unchanged.length===1`, `degraded===false` — demonstrating the net-new occurrences are not flagged.

#### 48. collectLineIgnoreDirectives re-derives next-line target with a different (and incompatible) algorithm than the core scanner, dropping/mis-attributing applied directives in the audit

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `fit-framework-define` · **Audit confidence:** high
- **Files:** `packages/fitness/engine/src/framework/ignore-processing.ts:146-159`
- **Code:**
  ```ts
  let targetLine = i + 1;
  while (
    targetLine < lines.length &&
    (lines[targetLine] ?? '').trimStart().startsWith('//')
  ) {
    targetLine++;
  }
  if (suppressedLines.has(targetLine + 1)) {
    found.push(toDirectiveEntry(filePath, i + 1, parsed));
  }
  ```
- **Concern:** API contract mismatch / data integrity (two implementations of the same line-resolution must agree)
- **Trigger:** A `@fitness-ignore-next-line <slug>` directive immediately followed by a stacked directive that the core scanner skips but this loop does not — e.g. a block-style `/* eslint-disable-next-line ... */` line, or more than MAX_DIRECTIVE_SKIP (3) stacked `//` directives. Concrete file:\nLine1: `// @fitness-ignore-next-line no-foo`\nLine2: `/* eslint-disable-next-line no-console */`\nLine3: `const x = BAD` (a real no-foo violation).
- **Expected:** Both the suppressor (core scanSuppressionDirectives) and the inventory must resolve the directive's target to line 3, so the applied directive is recorded in appliedDirectives.
- **Actual:** Core's isKnownDirectiveLine skips the `/*`-opened eslint line and targets line 3 (correctly suppressing the finding). The inventory loop only skips lines whose trimStart() startsWith('//'); the `/*` line is NOT skipped, so it computes targetLine pointing at line 2 and checks suppressedLines.has(2). Since the finding was suppressed on line 3, has(2) is false and the DirectiveEntry is silently dropped — a directive that actually fired is missing from the audit trail (and could be mis-attributed in the no-cap case). The same divergence affects hash (#) and HTML (<!--) directives, which parseDirec…
- **Why it matters:** appliedDirectives feeds the recipe session's directives audit (recipes/service.ts collectAppliedDirectives) and the directive/ignore-hygiene reporting. A suppression that silently waives a real finding but never appears in the audit defeats the purpose of the audit (a leaked/abused waiver becomes invisible) — exactly the failure mode the ADR-0014 single-source-of-truth consolidation was meant to prevent.
- **Recommendation:** Do not re-derive the target line. Have filterSignalsBySuppressions return enough info to attribute each suppressed match to its directive line (it already scans every file via scanSuppressionDirectives and knows directiveLines and the resolved target), or reuse scanSuppressionDirectives + the same isKnownDirectiveLine/MAX_DIRECTIVE_SKIP resolution here instead of the bespoke `startsWith('//')` loop.
- **Proving test:** Add an ignore-processing.test.ts case: fixture with `// @fitness-ignore-next-line no-foo`, then `/* eslint-disable-next-line x */`, then `const x = "FOO"`; signal at line 3. Assert filteredSignals is empty (suppressed) AND out.appliedDirectives has length 1 with type 'next-line'. Today the suppression happens but appliedDirectives is empty.

#### 49. analyze-mode silently swallows exceptions thrown by the check's analyze() (and applyContentFilter) as 'unreadable file' at DEBUG level

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `fit-framework-define` · **Audit confidence:** high
- **Files:** `packages/fitness/engine/src/framework/define-check.ts:109-130`
- **Code:**
  ```ts
  try {
    const rawContent = await ctx.readFile(filePath);
    const content = applyContentFilter(filePath, rawContent, config.contentFilter ?? 'none');
    const violations = config.analyze(content, filePath);
    for (const violation of violations) { void builder.addSignal(...); }
  } catch (error) {
    if (error instanceof CheckAbortedError) throw error;
    logger.debug('Skipping unreadable file', { evt: 'fitness.check.file.skip', ... });
  }
  ```
- **Concern:** Swallowed/incorrect error handling causing silent false negatives
- **Trigger:** Any check whose analyze() throws on a particular file's content — e.g. a malformed-input crash, a `.match(...)[1]` on a null, a RangeError, or applyContentFilter throwing for a pathological file. The exception is caught here, logged once at DEBUG as 'Skipping unreadable file', and that file produces zero violations.
- **Expected:** A genuine file-read failure should be skipped (per-file resilience), but an exception thrown by the check author's analyze() or by content filtering is a real error and should surface (the way analyzeAll mode does — its analyzeAll() is NOT wrapped, so it propagates to run()'s catch → buildError, marking the check errored).
- **Actual:** The try wraps readFile, applyContentFilter, AND analyze(). All non-abort throws are funneled into the same 'unreadable file' DEBUG log, so a buggy/crashing check silently scans nothing for the affected file(s) and still reports passed=true. There is no surfaced error, no WARN, and the gate sees no findings — a false negative that hides both check bugs and missed violations. This is inconsistent with analyzeAll mode, which surfaces such errors.
- **Why it matters:** Fitness checks gate CI (dogfood gate / Code Scanning). A check that throws on some files silently under-reports, so violations that should fail the gate pass it, with only a DEBUG line as evidence. Misclassifying a logic error as 'unreadable file' also makes diagnosis misleading.
- **Recommendation:** Narrow the try to only ctx.readFile (and possibly applyContentFilter), or catch and distinguish: re-throw / log at WARN/ERROR when the failure originates from analyze() rather than the read. At minimum, log the actual error object and use a non-'unreadable file' event for non-IO errors so check crashes are visible.
- **Proving test:** Define an analyze-mode check whose analyze() does `throw new Error('boom')` and run it over a readable fixture file. Today: result.passed === true, zero signals, only a DEBUG 'Skipping unreadable file'. Expected: the check should surface an error (mirroring analyzeAll, where the same throw yields buildError).

#### 50. memoryProfiler module singleton is never reset in production — unbounded profile accumulation across runs, contradicting its documented "reset per run" invariant

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `fit-framework-exec` · **Audit confidence:** high
- **Files:** `packages/fitness/engine/src/framework/memory-profiler.ts:40`, `packages/fitness/engine/src/framework/memory-profiler.ts:105`, `packages/fitness/engine/src/framework/memory-profiler.ts:137`, `packages/fitness/engine/src/framework/memory-profiler.ts:145`
- **Code:**
  ```ts
  private readonly profiles: CheckMemoryProfile[] = [];
  ...
    recordCheckComplete(...) { ... this.profiles.push(profile); return profile; }
  ...
  export const memoryProfiler = new MemoryProfiler();
  ```
- **Concern:** resource-lifecycle / shared mutable module state / documented-invariant contradiction
- **Trigger:** Any long-lived process (SaaS mode, or a server that constructs FitnessRecipeService repeatedly) that runs more than one recipe. Each check calls memoryProfiler.recordCheckComplete() (check-result-processor.ts:184,279), which pushes to the singleton's profiles array. The service finally block (recipes/service.ts:240-247) clears fileCache and the parse cache but never calls memoryProfiler.reset().
- **Expected:** Per the no-module-singleton exemption (checks-universal/.../no-module-singleton.ts:28-31) and ADR-0023, fileCache and memoryProfiler are 'reset per run and carry no cross-run identity'. Profiles from run N should not survive into run N+1, and the profiles array should not grow without bound.
- **Actual:** reset(), recordPrewarmComplete(), and getSummary() have ZERO production callers (only tests call reset()). profiles[] grows by ~one entry per check per run forever; in a long-lived multi-tenant process it is a steady memory leak. prewarmMemoryMB/peakMemoryMB are never populated (recordPrewarmComplete uncalled), so the summary getSummary() would report would be stale/zero — and getSummary() is dead code. The documented 'reset per run' invariant is false.
- **Why it matters:** Steady unbounded memory growth in any long-running embedding (the project explicitly targets SaaS mode). Also a latent data-integrity bug: if anyone ever wires up getSummary() (it is exported-shaped for that), it will mix profiles from every recipe ever run in the process and report peakMemoryMB=0/prewarmMemoryMB=0.
- **Recommendation:** Call memoryProfiler.reset() (and recordPrewarmComplete() after prewarm) in the recipe service lifecycle — e.g. in prepareExecution()/the finally block alongside fileCache.clear() — OR make the profiler RunScope-scoped like the parse cache so it has true per-run identity. At minimum, reset profiles at session start.
- **Proving test:** In one process: run service.runRecipe(r) twice; after the second run assert memoryProfiler.getSummary().allProfiles.length === (checks in run 2) — it will instead equal (run1 + run2). Also assert peakMemoryMB > 0 after a run with recordPrewarmComplete wired in.

#### 51. execAbortable drops an entire stdout/stderr chunk when it would exceed maxBuffer, instead of truncating to fill the buffer — silent total loss when maxBuffer < a single chunk

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `fit-framework-exec` · **Audit confidence:** high
- **Files:** `packages/fitness/engine/src/framework/abortable-exec.ts:124-128`, `packages/fitness/engine/src/framework/abortable-exec.ts:130-134`
- **Code:**
  ```ts
  child.stdout?.on('data', (chunk: string) => {
    if (stdout.length + chunk.length <= maxBuffer) {
      stdout += chunk;
    }
  });
  ```
- **Concern:** buffer management / silent data loss in command-mode checks
- **Trigger:** A command-mode check whose external tool (eslint, tsc, etc.) emits output near or beyond maxBuffer. Once accumulated length is close to the cap, any subsequent chunk that would cross the cap is dropped WHOLE (not appended up to the limit). Pathologically, if maxBuffer is smaller than the first OS pipe chunk (~64KB), the first chunk is dropped and so is everything after it, yielding stdout==='' (zero output).
- **Expected:** A buffer cap should truncate output to maxBuffer bytes (keep the first maxBuffer worth), or surface an explicit 'output truncated/too large' error so violations are not silently lost.
- **Actual:** The check `stdout.length + chunk.length <= maxBuffer` rejects the entire chunk when it would cross the boundary, so output lands well below maxBuffer (or at 0 if the very first chunk exceeds it). executeCommand (command-executor.ts:96) then parses this truncated/empty stdout into violations with no error — real findings vanish silently. (Secondary: maxBuffer is documented in BYTES but stdout.length/chunk.length are UTF-16 code units after setEncoding('utf8'), so the cap is in characters, not bytes — the memory bound is looser than documented for multi-byte output.)
- **Why it matters:** A check that should fail the gate can silently pass because its tool's output exceeded the buffer and was dropped — a wrong gate result with no diagnostic. The existing test (abortable-exec.test.ts:108-115) only asserts length<=1024, so it passes even when the real value is 0, masking the defect.
- **Recommendation:** Append the largest prefix of the chunk that fits (stdout += chunk.slice(0, maxBuffer - stdout.length)) and set a 'truncated' flag surfaced on ExecResult so callers can error instead of silently mis-parsing. Add a test asserting the captured output is non-empty and equals the first maxBuffer characters when output exceeds maxBuffer.
- **Proving test:** execAbortable(['sh','-c','yes x | head -c 200000'], { maxBuffer: 1024 }) should yield stdout.length === 1024 (a real prefix), not 0; and a >10MB stdout with default maxBuffer should set an explicit truncation indicator rather than silently dropping the tail.

#### 52. Scope-empty checks' file set is read from the mutable fileCache singleton during parallel execution — nondeterministic / order-dependent results

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** risk · **Subsystem:** `fit-framework-exec` · **Audit confidence:** medium
- **Files:** `packages/fitness/engine/src/framework/execution-context.ts:167-169`, `packages/fitness/engine/src/framework/file-cache.ts:115-135`, `packages/fitness/engine/src/framework/file-cache.ts:173-175`
- **Code:**
  ```ts
  if (matcher.includePatterns.length === 0) {
    return applyGlobalExcludes(fileCache.paths(), cwd, globalExcludes ?? []);
  }
  ...
  async get(filePath): Promise<string> { ... this.cache.set(absolutePath, content); return content; }
  ...
  paths(): readonly string[] { return [...this.cache.keys()].sort(); }
  ```
- **Concern:** cache-consistency / nondeterminism under concurrency
- **Trigger:** Parallel recipe execution (mode==='parallel', executeParallel runs up to maxParallel checks concurrently). A scope-empty check (e.g. file-length-limit, scope {languages:[],concerns:[]}) resolves its file set via fileCache.paths(). Meanwhile any concurrently-running check that calls ctx.readFile()/fileCache.get() on a path NOT covered by the prewarm patterns (e.g. a Dockerfile, .env, .yml) lazily adds that path to the shared cache via cache.set().
- **Expected:** A check's input file set should depend only on its scope/targets and the project config — deterministic regardless of which other checks happen to run before/after it within the same parallel window.
- **Actual:** fileCache is a process-wide mutable singleton populated both by prewarm AND by lazy get() during the run. fileCache.paths() therefore returns a set that changes as the run progresses, so a scope-empty check that runs late sees files that earlier checks lazily loaded, while one that runs early does not. The resulting violation set (and the gate outcome) becomes order-dependent across runs.
- **Why it matters:** Two runs of the same project can produce different findings for scope-empty checks depending on parallel scheduling — a reproducibility/gate-stability hazard. It also compounds the SaaS concern: two overlapping recipe runs in one process share this singleton and one run's finally{ fileCache.clear() } wipes the other run's cache mid-execution.
- **Recommendation:** Snapshot the prewarmed file set once at run start (e.g. capture fileCache.paths() right after prewarm into the RunScope / execution options) and feed scope-empty checks from that immutable snapshot, rather than re-reading the live cache. Long term, scope the file cache to RunScope so overlapping runs cannot interfere.
- **Proving test:** In parallel mode, register check A (scope-empty, records matchFiles() count) and check B (reads an off-prewarm-pattern path via ctx.readFile). Run repeatedly; A's reported file count should be constant. With current code it varies with scheduling / cache-mutation timing.

#### 53. Rust closures inside #[test] functions are mis-tagged as production code (inTestFile lost)

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `graph-adapter-langs` · **Audit confidence:** high
- **Files:** `packages/graph/graph-rust/src/walk.ts:538`, `packages/graph/graph-rust/src/walk.ts:489`
- **Code:**
  ```ts
  // buildClosureOccurrence:
      inTestFile: ctx.fileInTestFile,
  // vs buildFunctionOccurrence:
      const isTest = ctx.fileInTestFile || hasTestAttribute(node);
      ...
      inTestFile: isTest,
  ```
- **Concern:** Invalid state / contradicts documented behavior
- **Trigger:** A closure defined inside a `#[test]`-annotated (or `#[cfg(test)] mod`) function in a NON-`tests/`/non-`*_test.rs` file. The enclosing fn gets inTestFile=true (via hasTestAttribute), but the nested closure occurrence is built with `inTestFile: ctx.fileInTestFile` which is false.
- **Expected:** A closure lexically nested inside a function recognized as test code should also be treated as test code, mirroring the function-level rule documented in walk.ts lines 38-43.
- **Actual:** buildClosureOccurrence ignores the enclosing function's test status entirely (it has no access to the frame and only reads ctx.fileInTestFile). The closure occurrence carries inTestFile=false.
- **Why it matters:** inTestFile gates wide-function, large-function, always-throws-branch, no-side-effect-path, duplicated-function-body, and cycle rules (see packages/graph/engine/src/rules/*). A test-helper closure in a non-test source file can therefore be flagged as a production-code violation (e.g. a large closure body or duplicated body), producing a spurious gate finding on a contributor PR.
- **Recommendation:** Thread the enclosing frame's test status into buildClosureOccurrence (e.g. pass `frame`/an `inTest` boolean) and set `inTestFile: ctx.fileInTestFile || enclosingIsTest`. The same applies to the Java/Python lambda builders, which also hardcode `ctx.fileInTestFile` (graph-java/src/walk.ts:305, graph-python relies on the same pattern).
- **Proving test:** Walk a non-test `.rs` file containing `#[test] fn it() { let c = || { /* large body */ }; c(); }`. Assert the closure occurrence's `inTestFile === true` (currently false). Then run no-side-effect-path / large-function and confirm the closure is excluded.

#### 54. Java lambdas nested in @Test methods are mis-tagged as production code

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `graph-adapter-langs` · **Audit confidence:** high
- **Files:** `packages/graph/graph-java/src/walk.ts:305`, `packages/graph/graph-java/src/walk.ts:256`
- **Code:**
  ```ts
  // buildLambdaOccurrence:
      inTestFile: ctx.fileInTestFile,
  // vs buildMethodOccurrence:
      const inTest = ctx.fileInTestFile || hasTestAnnotation(decorators);
      ...
      inTestFile: inTest,
  ```
- **Concern:** Invalid state / contradicts documented behavior
- **Trigger:** A `lambda_expression` inside a method annotated `@Test` (etc.) that lives in a file whose path/name does NOT match the test patterns (`/test/`, `*Test.java`, `*Tests.java`, `*IT.java`). The method is tagged inTestFile=true via hasTestAnnotation; the nested lambda is built with ctx.fileInTestFile=false.
- **Expected:** A lambda lexically nested inside a method recognized as a test (via @Test annotation) should also be treated as test code, consistent with the method-level rule (walk.ts lines 50-54).
- **Actual:** buildLambdaOccurrence hardcodes `inTestFile: ctx.fileInTestFile`, ignoring the enclosing method's annotation-derived test status.
- **Why it matters:** As above, inTestFile gates six graph rules. A lambda body inside an inline @Test method in a non-test-named file can be flagged as a production violation, yielding a false-positive gate alert.
- **Recommendation:** Pass the enclosing frame's effective test status into buildLambdaOccurrence and OR it into inTestFile.
- **Proving test:** Walk a file `src/main/java/Foo.java` (non-test path) with `@Test void t(){ Runnable r = () -> { ... }; }`. Assert the lambda occurrence's inTestFile === true (currently false).

#### 55. Java import-dependency FQN index is derived from file path, ignoring the actual `package` declaration — drops edges on package/path mismatch

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** risk · **Subsystem:** `graph-adapter-langs` · **Audit confidence:** high
- **Files:** `packages/graph/graph-java/src/resolve-dependencies.ts:132`, `packages/graph/graph-java/src/resolve-dependencies.ts:71`
- **Code:**
  ```ts
  function filePathToJavaTypeFQN(filePath: string): string | null {
    ...
    for (const prefix of JAVA_SOURCE_ROOT_PREFIXES) {
      if (filePath.startsWith(prefix)) { stripped = filePath.slice(prefix.length); break; }
    }
    const noExt = stripped.slice(0, -'.java'.length);
    return noExt.replaceAll('/', '.');
  }
  ```
- **Concern:** API contract mismatch / stale-resolution; edges silently dropped
- **Trigger:** Any Java project whose physical layout does not place files under one of the three hardcoded roots (`src/main/java/`, `src/test/java/`, `src/`) OR whose `package` declaration does not mirror the directory path. Example: file at `app/Foo.java` declaring `package com.example;`. An `import com.example.Foo;` in a sibling resolves against the index key `app.Foo`, not `com.example.Foo`, so `to: []`.
- **Expected:** The dependency target FQN should be the file's declared package + type name. The walk already computes the declared package via extractPackageName and uses it for the occurrence's qualifiedName (walk.ts:258, packageQualifier).
- **Actual:** resolve-dependencies re-derives the FQN purely from filePath and source-root stripping, discarding the declared package that the walk already knows. When path and package disagree (or the file is outside the known roots), the import resolves to [] (unresolved) even though the target IS in the catalog.
- **Why it matters:** Dependency edges (DEC-498) silently miss in-project targets — a same-project import shows as external. The qualifiedName (path-derived-or-declared) and dependency-edge resolution (path-derived) use two different notions of FQN, so the graph is internally inconsistent for non-canonical layouts. This is partially documented as out-of-scope, but the available declared-package signal makes it a fixable correctness gap rather than a fundamental limitation.
- **Recommendation:** Carry the declared package into the catalog (or recompute the FQN as `<declaredPackage>.<simpleTypeName>` for the type-FQN index) rather than slash-to-dotting the stripped path. The simpleTypeName is the file's primary type (often the file stem). This makes import resolution robust to package/path divergence and to files outside the canonical roots.
- **Proving test:** Build a project with `app/Foo.java` (package com.example) and `app/Bar.java` (package com.example) where Bar imports `com.example.Foo`. Assert the Bar→Foo dependency edge resolves to Foo's module-init bodyHash (currently `to: []`).

#### 56. cacheKey is NOT location-independent: resolved tsconfig baseUrl/outDir/rootDir are absolute paths that aren't stripped, so the same project under a different absolute root produces a different cache key

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `graph-adapter-ts` · **Audit confidence:** high
- **Files:** `packages/graph/graph-typescript/src/cache-key.ts:101-107`, `packages/graph/graph-typescript/src/cache-key.ts:90`, `packages/graph/graph-typescript/src/cache-key.ts:97`
- **Code:**
  ```ts
  const LOCATION_KEYS = new Set(['configFilePath', 'pathsBasePath']);
  const entries = Object.entries(options as Record<string, unknown>)
    .filter(([k]) => !LOCATION_KEYS.has(k))
    .sort(([a], [b]) => a.localeCompare(b));
  ```
- **Concern:** cache-consistency / API-contract mismatch (documented invariant vs behavior)
- **Trigger:** Any tsconfig that sets baseUrl, outDir, rootDir, rootDirs, typeRoots, or declarationDir (the overwhelmingly common case — this repo's own package tsconfigs set outDir:"dist"/rootDir:"src"). The resolved compilerOptions for these are ABSOLUTE paths.
- **Expected:** Per the file's own docstring (lines 93-100) and the F2 invariant: 'the key is location-independent (a checkout under a different absolute root still hits)'. Two checkouts of the same project at different absolute roots should yield the same cacheKey so the cross-machine/CI cache reuses fragments.
- **Actual:** parseJsonConfigFileContent resolves baseUrl/outDir/rootDir to absolute paths (verified: baseUrl:"." -> "/tmp/cktest", outDir:"dist" -> "/tmp/cktest/dist"). These keys are NOT in LOCATION_KEYS, so they enter stableStringify and the sha256. The same project at /Users/.../opensip-cli vs CI's /home/runner/work/opensip-cli yields a DIFFERENT key -> guaranteed cache miss, defeating the documented location independence. The 'location-independent' unit test (cache-key.test.ts:87) only uses target+strict (no absolute-path options), so it passes while the real-world case fails — a test gap masking the d…
- **Why it matters:** Cache misses on every machine/path change defeat the warm-cache and committed-baseline reuse the design promises (the whole point of the resolution-aware key). Direction is safe (recompute, never a wrong graph), so severity is medium not high — but it silently nullifies caching for essentially every real monorepo.
- **Recommendation:** Either (a) add the absolute-path-valued resolved options (baseUrl, outDir, rootDir, declarationDir, rootDirs, typeRoots, outFile, tsBuildInfoFile, ...) to a normalization step that rewrites them project-root-relative before hashing, or (b) hash the RAW merged extends-chain config text (location-relative) rather than the resolved options. Then extend the test to assert location-independence WITH baseUrl/outDir/rootDir set.
- **Proving test:** In cache-key.test.ts, write the SAME tsconfig content `{"compilerOptions":{"target":"ES2022","outDir":"dist","rootDir":"src"}}` into two different temp dirs (dir, dir2) and assert cacheKey(dir,...) === cacheKey(dir2,...). It currently fails; with target+strict only it passes.

#### 57. `graph --workspace --sarif <path>` silently produces no SARIF file

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** risk · **Subsystem:** `graph-cli` · **Audit confidence:** high
- **Files:** `packages/graph/engine/src/cli/graph.ts:164-168`, `packages/graph/engine/src/cli/graph/graph-command-spec.ts:297-299`
- **Code:**
  ```ts
  if (opts.sarif !== undefined && opts.sarif !== '' && envelope !== undefined) {
    await cli.writeSarif(envelope, opts.sarif);
  }
  ```
- **Concern:** silent failure — a requested output artifact is never written and no error/warning is emitted
- **Trigger:** `opensip graph --workspace --sarif out.sarif`. `executeGraph` returns `undefined` for the workspace path (line 167, by design — the parent does not emit a deliverable envelope). Back in runGraphCommand the SARIF write is guarded by `envelope !== undefined`, so it is skipped with no diagnostic.
- **Expected:** Either write an aggregated SARIF for the workspace run, or fail/warn that --sarif is unsupported with --workspace. The --sarif help text ('Also write this run's findings as a SARIF 2.1.0 file ... Composes with --gate-save') gives no hint it is a no-op under --workspace.
- **Actual:** No SARIF file is created and the command exits 0. A CI 'upload SARIF if: always()' step then finds no file (or uploads a stale one).
- **Why it matters:** A user combining the documented polyglot fan-out with Code Scanning export gets no output and no signal that anything went wrong — the artifact they configured CI around is silently absent.
- **Recommendation:** In runGraphCommand, if `opts.sarif` is set but `envelope === undefined` because of --workspace, emit a clear warning (or reject --workspace+--sarif in validateMutuallyExclusiveFlags). Long-term: aggregate per-unit signals into one workspace SARIF.
- **Proving test:** Run `graph --workspace --sarif /tmp/out.sarif` against a multi-unit fixture and assert /tmp/out.sarif exists (currently it does not), or that a warning is emitted.

#### 58. Equivalence-diff indexEdges keys edges by bodyHash@line:col (NOT ownerEdgeKey) — collides body-twins, contradicting the ADR-0003 invariant the rest of this module enforces

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `graph-orchestrate` · **Audit confidence:** high
- **Files:** `packages/graph/engine/src/cli/orchestrate/cross-shard-resolve.ts:701-719`
- **Code:**
  ```ts
  function indexEdges(catalog: Catalog): ReadonlyMap<string, IndexedEdge> {
    const map = new Map<string, IndexedEdge>();
    for (const occs of Object.values(catalog.functions)) {
      ...
      for (const e of o.calls) {
        const key = `${o.bodyHash}@${String(e.line)}:${String(e.column)}`;
        map.set(key, { ... });
  ```
- **Concern:** API contract mismatch / verification-harness blind spot (ADR-0003 violation in the equivalence gate)
- **Trigger:** Two body-twin occurrences (byte-identical bodies => identical bodyHash) live in DIFFERENT files (e.g. a stripStrings-style helper copy-pasted across lang adapters) and each carries a call edge at the same line:col. Both engines' catalogs contain both twins.
- **Expected:** The equivalence diff must distinguish edges per OCCURRENCE via ownerEdgeKey(bodyHash, filePath) — the exact invariant edge-identity.ts/owner-key.ts mandate and that bucketEdgesByOwner/stitchCrossShardEdges in THIS file already follow. Each twin's edge is its own.
- **Actual:** indexEdges uses bodyHash alone in the key, so two twins' edges at the same line:col collapse to one map entry (last writer wins). Because the exact catalog (stitchEdges: Object.entries order) and the sharded catalog (canonicalizeFunctions: sorted order) iterate occurrences in DIFFERENT orders, the surviving 'last writer' can differ between sides — the diff can FABRICATE a phantom difference or MASK a real dropped/mis-resolved edge on one twin. This is the equivalence gate's currency (diffCatalogs -> diffCatalogsByEdge), so a real divergence can pass unseen, or a non-divergence can fail.
- **Why it matters:** The whole point of this subsystem is the sharded≡exact equivalence guarantee; the gate that proves it can be blind to (or invent) exactly the body-twin edge divergences the rest of the module was carefully rewritten to handle. A wrong gate verdict is a correctness regression in the safety net.
- **Recommendation:** Key indexEdges by `${ownerEdgeKey(o.bodyHash, o.filePath)}@${e.line}:${e.column}` (import the canonical ownerEdgeKey from edge-identity.js), consistent with bucketEdgesByOwner and stitchCrossShardEdges.
- **Proving test:** Build two catalogs each with two occurrences sharing a bodyHash in files a.ts and b.ts, both with a call edge at line:1 col:1 but with DIFFERENT to-sets per file; make catalog A and catalog B agree per-occurrence but differ in occurrence iteration order. Assert diffCatalogsByEdge reports 0 differences (it currently can report a spurious one, or hide a genuine one if you make one twin's edge actually diverge).

#### 59. Cross-package boundary resolution groups packages by packageOf (^packages/<seg>/) — collapses all packages to '<unknown>' for non-packages/ layouts, risking phantom cross-package edges

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** risk · **Subsystem:** `graph-orchestrate` · **Audit confidence:** medium
- **Files:** `packages/graph/engine/src/cli/orchestrate/cross-shard-resolve.ts:387-397`, `packages/graph/engine/src/cli/orchestrate/cross-shard-resolve.ts:273-282`
- **Code:**
  ```ts
  const linked = resolveCrossPackageCall({ importSpecifier: spec, calleeName: bc.calleeName, exportIndex: ctx.exportIndex, manifestIndex: ctx.manifestIndex });
  const edge = linked === undefined ? { ...base, to: [] } : { ...base, to: [linked.bodyHash] };
  ```
- **Concern:** shard-boundary symbol resolution correctness (phantom cross-package edge); code path contradicts the module's documented uniqueness guarantee
- **Trigger:** A multi-package monorepo whose workspace packages do NOT live under a top-level `packages/` directory (e.g. apps/* and services/* units, or any non-`packages/` layout). The header of cross-shard-resolve.ts promises an edge ONLY when the specifier+name resolve to a UNIQUE export in the IMPORTED package.
- **Expected:** resolveOne branch (b) should disambiguate the callee name within the package the import specifier actually names.
- **Actual:** Both the ExportIndex key (buildExportIndex -> packageOf(occ.filePath)) and resolveSpecifierToPackage's returned packageGroup (packageOf(manifest.dir+'/')) come from packageOf, which returns the literal '<unknown>' for any path not matching ^packages/([^/]+)/. For an apps/services/ layout every package collapses to one '<unknown>' export bucket, so resolveCrossPackageCall links a callee name to any uniquely-named export across ALL units regardless of which package the specifier names — a cross-package edge into a package the caller never imported (the exact phantom-coupling failure the module s…
- **Why it matters:** Phantom cross-package edges fail the graph gate (coupling/cycle rules) and mislead the dashboard's coupling view for any non-`packages/`-rooted monorepo — a layout the flat/polyglot discovery explicitly supports.
- **Recommendation:** Group the ExportIndex and resolveSpecifierToPackage by the manifest package NAME (or a path-prefix derived from the actual unit rootDirs) rather than the hardcoded `packages/<seg>` heuristic, so cross-package disambiguation works for arbitrary monorepo layouts. (Fix lands in export-index.ts/resolve-callee.ts; verify via the in-scope resolveOne path.)
- **Proving test:** Build a 2-unit fixture under apps/web and services/api where both export a uniquely-named function and apps/web imports services/api by its bare name; resolve a boundary call from apps/web to services/api's symbol and to a NON-imported services/* symbol. Assert the non-imported call DECLINES (to: []) rather than linking via the merged '<unknown>' bucket.

#### 60. Merged-catalog cacheKey truncates the joined per-shard keys to 64 chars (hashKeys slice(0,64)) — for flat-large all shard keys are identical and the window misses content changes

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** risk · **Subsystem:** `graph-orchestrate` · **Audit confidence:** medium
- **Files:** `packages/graph/engine/src/cli/orchestrate/cross-shard-resolve.ts:150-153`, `packages/graph/engine/src/cli/orchestrate/cross-shard-resolve.ts:251-255`
- **Code:**
  ```ts
  cacheKey: stampEngineVersion(`sharded-${String(fragments.length)}-${hashKeys(fragments)}`, 'sharded'),
  ...
  function hashKeys(fragments) { return [...fragments.map((f) => f.cacheKey)].sort().join('+').slice(0, 64); }
  ```
- **Concern:** stale-data / cache-key does not include all inputs (claimed invariant vs actual)
- **Trigger:** A flat-large synthetic-partition build: graph.ts resolveSyntheticFlatShards gives every shard the SAME rootDir (project root) and SAME configPathAbs, so every shard fragment's adapter cacheKey is byte-identical. After sort+join, slice(0,64) is dominated by the common `eng=..|mode=sharded|ts-..-<tsconfighash>` prefix.
- **Expected:** The doc comment (lines 144-153) states the merged cacheKey 'invalidates when any shard's key changes'. The key should be a collision-resistant function of the full sorted shard-key set.
- **Actual:** hashKeys joins keys then truncates to 64 chars, so distinct shard-key SETS that share a 64-char prefix produce the SAME merged cacheKey. With identical flat-large keys the merged cacheKey reduces to (fragment count, common key prefix) and reflects neither shard ids nor file fingerprints. Today no consumer reuses based on this merged cacheKey (the sharded path re-merges from per-shard fragments + fingerprints, and the cross-engine read is blocked by mode=sharded), so it is currently latent — but the invariant the comment asserts is false.
- **Why it matters:** If any future code keys reuse off the merged catalog's cacheKey (rather than fragments+filesFingerprint), it will silently reuse a stale catalog after a content change — the 'silently-wrong graph' class this module repeatedly guards against. It is a fragile foundation contradicting its own contract.
- **Recommendation:** Replace the join+slice with a real digest of the full sorted shard-key list (e.g. sha256(sortedKeys.join('\n')).slice(0,16)) so the merged cacheKey is a collision-resistant function of every shard key; do not truncate the pre-hash concatenation.
- **Proving test:** Construct two fragment sets with the same count whose sorted shard-cacheKey lists agree in their first 64 chars but differ later; assert mergeShardFragments produces DIFFERENT catalog.cacheKey values (currently identical).

#### 61. Graph catalog cache is not invalidated when a workspace package.json `name` changes (package rename) — stale package labels and cross-package edges replayed

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `graph-pipeline` · **Audit confidence:** high
- **Files:** `packages/graph/engine/src/pipeline/assign-packages.ts:83-100`, `packages/graph/engine/src/cache/invalidate.ts:96-107`, `packages/graph/engine/src/cache/engine-version.ts:79-81`
- **Code:**
  ```ts
  // assign-packages.ts
  const parsed = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: unknown };
  return typeof parsed.name === 'string' ... ? parsed.name : null;
  
  // invalidate.ts computeFilesFingerprint — fingerprints only the discovered source files:
  for (const f of files) { const st = statSync(f); parts.push(`${f}|${st.mtimeMs}|${st.size}`); }
  ```
- **Concern:** stale-data / cache-consistency: a relevant input (package.json name) is omitted from every cache key
- **Trigger:** Run `graph` once (populates the catalog cache). Rename a workspace package (edit only its package.json `name`, e.g. `@scope/a` → `@scope/a-renamed`) without touching any .ts source. Re-run `graph`.
- **Expected:** The catalog rebuilds because assignPackages would now stamp different `occurrence.package` labels and constrainCrossPackageEdges/coupling/export-index would bucket differently.
- **Actual:** classifyCatalog returns `valid` (language, adapter cacheKey, and source-file fingerprint all unchanged — the TS adapter cacheKey is `ts-<ver>-adapter-<ver>-<mode>-<resolvedTsconfigHash>`, and computeFilesFingerprint covers only .ts(x) files, not package.json). The stale catalog is returned wholesale with the OLD package labels and old cross-package edges. `assignPackages` reads package.json `name` but no cache key reflects that content.
- **Why it matters:** assignPackages output feeds the package-coupling matrix (graph:unexpected-coupling gate), SCC `crossesPackages`, and constrainCrossPackageEdges' reachability comparisons. A stale label can flip a gate result (false coupling violation or a missed one) on a cached run; `--no-cache` is the only recovery and contributors won't know to use it.
- **Recommendation:** Fold the manifest content that assignPackages/constrain depend on into a cache key — e.g. hash each workspace package.json `name` (and `exports` used by resolveSpecifierToPackage) into the adapter cacheKey or the engine-version stamp, or include the package.json files in computeFilesFingerprint. Over-invalidation (one cold rebuild on a no-op manifest edit) is the documented safe default already used for the engine version.
- **Proving test:** Integration test: build a catalog over a fixture monorepo, assert a coupling/package result; rename a package in package.json only; rebuild with cache enabled; assert classifyCatalog (or the resulting catalog's occurrence.package) reflects the new name rather than reusing the stale one.

#### 62. Cross-package export resolution collapses all packages into one `<unknown>` bucket for non-`packages/` monorepo layouts (flat / apps / crates / Go-module repos)

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `graph-pipeline` · **Audit confidence:** high
- **Files:** `packages/graph/engine/src/resolve-callee.ts:17-28`, `packages/graph/engine/src/cross-package/export-index.ts:81-86`, `packages/graph/engine/src/cross-package/export-index.ts:343-344`
- **Code:**
  ```ts
  const PACKAGE_RE = /^packages\/([^/]+)\//;
  export function packageOf(filePath: string): string { const m = PACKAGE_RE.exec(filePath); return m ? m[1] : '<unknown>'; }
  // export-index.ts buildExportIndex: const pkg = packageOf(occ.filePath);
  // export-index.ts resolveSpecifierToPackage: const packageGroup = packageOf(`${manifest.dir}/`);
  ```
- **Concern:** resolution ambiguity / API contract mismatch: the export index's package-group key only distinguishes packages under `packages/<seg>/`
- **Trigger:** A workspace whose package roots are NOT under `packages/` (e.g. `apps/api`, `apps/web`, Rust `crates/*`, or a Go-module repo). One package imports `import { foo } from '@scope/api'` where `foo` is exported by a DIFFERENT workspace package.
- **Expected:** `resolveCrossPackageCall` resolves `foo` only against `@scope/api`'s exports; if not exported there, it declines (no edge).
- **Actual:** `buildExportIndex` keys every occurrence's exports by `packageOf(filePath)`, which returns `<unknown>` for any path outside `packages/`. So ALL packages' exports merge into a single `<unknown>` bucket, and `resolveSpecifierToPackage` returns `packageGroup='<unknown>'` for every workspace specifier. A globally-unique simple name then links to whatever package defines it — even the wrong one — manufacturing a cross-package phantom edge; non-unique names always decline, suppressing real edges.
- **Why it matters:** assignPackages explicitly documents support for apps/libs/crates/Go-module layouts, and the graph tool ships Go/Rust/Java adapters. For those repos cross-package resolution is effectively keyed by a single group, breaking package-scoped semantic resolution (wrong or missing cross-package edges in the coupling gate).
- **Recommendation:** Key the export index and the specifier resolver by a layout-agnostic package identity — the same nearest-package.json `name` that assignPackages stamps (occurrence.package), or the manifest dir itself — instead of the `packages/<seg>` path heuristic. packageOf should not be the bucketing key for cross-package linking on non-`packages/` repos.
- **Proving test:** Build an ExportIndex over a fixture with roots `apps/a` (exports `foo`) and `apps/b` (exports `bar`); resolveCrossPackageCall({importSpecifier:'@scope/b', calleeName:'foo', ...}) must DECLINE (foo is not in b), but currently links because both collapse to `<unknown>`.

#### 63. Catalog JSON export sorts symbols/edges with localeCompare instead of code-point order, breaking the documented byte-equivalence/determinism contract

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `graph-render-persist` · **Audit confidence:** medium
- **Files:** `packages/graph/engine/src/render/catalog-json.ts:346-349`
- **Code:**
  ```ts
  // Stable ordering — deterministic output is the golden-fixture
  // contract. Sort by id (sha256 hex string, lexicographic).
  symbols.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));
  ```
- **Concern:** determinism / serialization stability
- **Trigger:** Run the catalog export on two machines (or the same machine under different LANG / ICU collation tables, or different Node ICU builds). For SHA-256 hex ids (`[0-9a-f]`) the default locale usually agrees with code-point order, but localeCompare is locale/ICU-dependent and not guaranteed to equal lexicographic code-point order.
- **Expected:** Byte-identical output across runs/machines so golden fixtures hold and `INSERT ... ON CONFLICT DO UPDATE` re-ingestion is idempotent (the file's own stated contract: 'Ordering ... is stable across runs (sorted by id) so byte-equivalence holds for golden-fixture tests and idempotent re-ingestion').
- **Actual:** Ordering is produced by `String.prototype.localeCompare`, whose collation is locale- and ICU-version-sensitive. The comment claims 'lexicographic', but localeCompare is collation-based, not code-point lexicographic. A locale where digits/letters or case fold differently would reorder the arrays, producing a different byte stream for the same catalog.
- **Why it matters:** The export feeds opensip's substrate ingestor and golden-fixture tests; a non-deterministic byte stream silently breaks the idempotent-re-ingestion guarantee and can flap golden tests on CI runners with different locales.
- **Recommendation:** Use a code-point comparator: `symbols.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))` (or `localeCompare(b.id, 'en', { sensitivity: 'variant' })` pinned to a fixed locale). Code-point comparison matches the 'lexicographic over sha256 hex' intent exactly.
- **Proving test:** Render a catalog with ids that differ only where collation diverges from code-point order, run the sort with `process.env.LANG` set to two different locales (or compare `localeCompare` vs `<` ordering for a crafted set), and assert the JSON byte string is identical; today it can differ.

#### 64. Body-twin collapse in byBodyHash undercounts large-function / wide-function findings

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `graph-rules` · **Audit confidence:** high
- **Files:** `packages/graph/engine/src/rules/large-function.ts:40`, `packages/graph/engine/src/rules/wide-function.ts:36`, `packages/graph/engine/src/pipeline/indexes.ts:125`
- **Code:**
  ```ts
  for (const occ of indexes.byBodyHash.values()) {  // large-function.ts:40 / wide-function.ts:36
  ...
  maps.byBodyHash.set(o.bodyHash, o);            // indexes.ts:125 (last-writer-wins)
  ```
- **Concern:** stale-data/incomplete-coverage; finding undercount
- **Trigger:** Two or more functions in different files whose NORMALIZED body text is byte-identical (e.g. a copy-pasted 400-line helper, or two identical 8-param functions). They share one bodyHash, so byBodyHash keeps only the last-written occurrence.
- **Expected:** Each oversized/over-wide production function emits its own signal (or at least every occurrence is considered for the gate).
- **Actual:** Only ONE of the N identical-bodied occurrences is iterated (byBodyHash is content-deduped, last-writer-wins per indexes.ts:125). The other N-1 copies are silently never evaluated by large-function / wide-function, so they produce no signal and do not count toward the gate. When the developer edits one copy (diverging its hash), the previously-hidden twin then surfaces, so the count appears to move erratically as copies are fixed.
- **Why it matters:** large-function and wide-function are documented production-quality gates (CLAUDE.md). A repo with copy-pasted oversized functions under-reports them, and the per-instance count is not the true number of offending functions — undermining 'the count reaches zero when fixed' gating intuition and giving a misleading clean-bill on duplicated bloat.
- **Recommendation:** Iterate over indexes.byOccId.values() (or occurrencesByHash, flattened) for the per-occurrence quality rules (large-function, wide-function, always-throws-branch, no-side-effect-path candidate scan) so every occurrence is evaluated; or explicitly document that these rules report one representative per body-twin group. duplicated-function-body already iterates the catalog directly for exactly this reason (see its groupByHash comment at duplicated-function-body.ts:165).
- **Proving test:** Build a catalog with two FunctionOccurrences in different files sharing one bodyHash, each 400 lines (endLine-line+1=400), kind!=module-init, inTestFile=false. Assert largeFunctionRule.evaluate emits 2 signals. Today it emits 1.

#### 65. cycle rule trusts SCC crossesPackages flag that is computed including test-file members

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** risk · **Subsystem:** `graph-rules` · **Audit confidence:** medium
- **Files:** `packages/graph/engine/src/rules/cycle.ts:61`, `packages/graph/engine/src/rules/cycle.ts:65`, `packages/graph/engine/src/rules/cycle.ts:110`
- **Code:**
  ```ts
  if (isTestOnlyScc(scc, indexes)) continue;   // keeps any SCC with >=1 prod member
  ...
  if (scc.crossesPackages) return 'high';      // bandFor: cross-package wins, severity high
  ```
- **Concern:** wrong gate severity / contradicts production-only intent
- **Trigger:** An SCC that contains at least one production member AND at least one test-file member in a DIFFERENT package (e.g. a production function mutually recursive with a test fixture, or a production cycle that also pulls in a test helper located under a different package). computeSccs/buildOccGraph (pipeline/features.ts:311) builds the SCC graph over ALL occurrences with no test filter, and toSccFeatures (features.ts:418) sets crossesPackages over those members including test ones.
- **Expected:** cycle is a production-architecture gate; a cycle's cross-package HIGH severity should reflect production package boundaries, not a span manufactured by a test-file member.
- **Actual:** isTestOnlyScc keeps the cycle (a production member exists), but bandFor reads scc.crossesPackages which may be true ONLY because a test-file member lives in another package, elevating the finding to base 'high'. The rule does not recompute crossesPackages over production-only members.
- **Why it matters:** Other production-gating graph rules (and computePackageCoupling at features.ts:448) deliberately exclude test occurrences so test code never manufactures phantom cross-package architecture signals. cycle.ts diverges: it filters test-ONLY cycles but still inherits a test-influenced crossesPackages, producing an over-severe (high) cross-package cycle finding driven by test code.
- **Recommendation:** In cycle.ts compute crossesPackages over the SCC's PRODUCTION (non-inTestFile) resolvable members only (reuse packagesOf but skip inTestFile occurrences), and gate the 'high' band on that, mirroring the test-exclusion every other production rule applies.
- **Proving test:** Construct an SCC with members: prod occ in pkg A and a test-file occ in pkg B, both production-vs-test mixed so isTestOnlyScc is false and crossesPackages is true. Assert cycleRule emits severity reflecting a single production package (not 'high' cross-package).

#### 66. isInComment returns false for positions inside multi-line block comments and trailing (mid-line) block comments

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `lang-adapters` · **Audit confidence:** high
- **Files:** `packages/languages/lang-typescript/src/ast-utilities.ts:198-213`
- **Code:**
  ```ts
  for (let i = 0; i < lineStarts.length; i++) {
    const lineStart = lineStarts[i] ?? 0;
    ...
    if (position < lineStart || position >= lineEnd) continue;
    if (isPositionInRanges(position, ts.getLeadingCommentRanges(text, lineStart))) return true;
    if (isPositionInRanges(position, ts.getTrailingCommentRanges(text, lineStart))) return true;
  }
  ```
- **Concern:** comment-detection false negative
- **Trigger:** A position inside a /* ... */ block comment when that position is NOT on the comment's first line (multi-line block), OR a trailing block comment that begins mid-line after code (e.g. `const x = 1; /* banned */`).
- **Expected:** isInComment(position, sf) returns true for any position that falls within a comment range (single-line, multi-line block, leading, or trailing).
- **Actual:** Proven false negatives: for '/* line1\n   secret here\n   line3 */\nconst x=1;' the position of 'secret' (on line 2) returns false; for 'const x = 1; /* trailing banned */' the position of 'banned' returns false. Only comments that begin at a line's start (and the queried position is on that same line) are detected, because ts.getLeadingCommentRanges/getTrailingCommentRanges are called with `lineStart` — they only find trivia that begins exactly at the start of the line, so a comment opened mid-line or a continuation line of a block comment is missed.
- **Why it matters:** This is a documented public AST helper (CLAUDE.md lists isInComment among the canonical helpers check authors should use to suppress false positives). A check using it to ignore a banned-API name that appears inside a multi-line JSDoc or a trailing block comment will incorrectly emit a violation (false positive) on documentation, or fail to suppress as intended — undermining the very purpose of the helper.
- **Recommendation:** Don't drive detection off per-line `getLeadingCommentRanges(text, lineStart)`. Instead scan all comment ranges once (e.g. collect via the scanner like filter.ts does, or walk leading/trailing trivia of every token / use ts.forEachLeadingCommentRange / ts.forEachTrailingCommentRange anchored at token starts) and test `position` against the full set of ranges. The filterContent isInComment(line,col) predicate already does this correctly via commentRegions — consider delegating.
- **Proving test:** const sf = parseSource('/*a\n secret\n*/\nx;', 'x.ts'); expect(isInComment(content.indexOf('secret'), sf)).toBe(true); const sf2 = parseSource('const x=1; /* banned */', 'x.ts'); expect(isInComment(content2.indexOf('banned'), sf2)).toBe(true);

#### 67. No test coverage for astral/non-BMP characters in any language adapter strip/filter path

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** improvement · **Subsystem:** `lang-adapters` · **Audit confidence:** high
- **Files:** `packages/languages/lang-typescript/src/__tests__/filter.test.ts`, `packages/languages/lang-typescript/src/__tests__/ast-utilities.test.ts`
- **Code:**
  ```ts
  // grep for 😀/emoji/surrogate/codePoint/\u{1F.../U0001 across filter.test.ts and ast-utilities.test.ts -> no matches
  ```
- **Concern:** test gap around offset/position correctness with multibyte input
- **Trigger:** The filterContent UTF-16 vs code-point bug (finding #1) ships undetected precisely because no test feeds an astral character through stripStrings/stripComments/filterContent. The C-family packs are correct-by-construction (split('')), but they also have no astral-char regression test pinning that invariant.
- **Expected:** Each adapter's strip suite should include a fixture with an emoji/astral char before a string literal and a comment, asserting (a) byte length preserved, (b) the literal/comment bodies blanked at the correct positions, (c) real code untouched.
- **Actual:** No such fixtures exist; the position-correctness invariant for non-BMP input is entirely unverified across all six packs.
- **Why it matters:** This is the missing guardrail that would have caught finding #1 and would prevent the C-family packs from regressing if someone 'simplifies' applyRegions to use spread/Array.from (the code comment warns against it, but nothing enforces it).
- **Recommendation:** Add an astral-character regression test to lang-typescript filter.test.ts (and a shared one for the C-family strip suites): const r = filterContent('x="a😀b";const k="y";'); assert string bodies blanked, delimiters intact, length equal. Mirror for stripStrings/stripComments in each lang-* pack.
- **Proving test:** For each adapter: const out = adapter.stripStrings(src_with_emoji_then_string); expect(out.length).toBe(src.length); expect(out).toBe(expected_blanked); // fails today for lang-typescript

#### 68. 0-based columns emitted verbatim as SARIF columns (off-by-one); graph occurrences are documented 0-based but SARIF columns are 1-based

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** risk · **Subsystem:** `output` · **Audit confidence:** high
- **Files:** `packages/output/src/format/signal-sarif.ts:138-144`, `packages/output/src/format/signal-sarif.ts:55-62`
- **Code:**
  ```ts
  // SARIF 2.1.0 requires region.startLine / region.startColumn to be >= 1.
  const startColumn = atLeastOne(signal.code?.column ?? signal.column);
  ```
- **Concern:** line/col 0-vs-1 indexing
- **Trigger:** graph rules build `code: { file: occ.filePath, line: occ.line, column: occ.column }` where occ.column is documented 0-based (graph/engine/src/types.ts: `/** 0-based column. */`). The SARIF emitter takes the value as-is.
- **Expected:** SARIF column coordinates are 1-based. A producer's 0-based column should map to SARIF column = col+1.
- **Actual:** A graph finding at 0-based column 5 emits SARIF startColumn 5, which points one column to the left in the source; and a genuine 0-based column 0 (first column) is silently dropped by atLeastOne() as if it had no column. The two layers disagree about the column origin and there is no normalization or documented contract that the producer must pre-convert.
- **Why it matters:** Causes mislocated Code Scanning annotations on PR diffs (off-by-one column) for graph findings, and drops legitimate column-0 locations. The emitter is the SARIF-conformance authority but assumes 1-based input without enforcing or documenting it.
- **Recommendation:** Decide and document the indexing contract at this boundary. Either require producers to pass 1-based coordinates (assert/normalize) or have graph convert 0-based→1-based before stamping `code`. The atLeastOne() comment claims 0 means 'no column', which conflicts with graph's 0=first-column semantics — reconcile.
- **Proving test:** Feed a graph-shaped signal with code.column=0 (meaning first column) and code.line=10; current output drops the column entirely. Feed column=5 and verify the annotation lands on the intended character vs one to the left.

#### 69. diffBaseline collapses multiple current signals sharing a fingerprint — net-new findings under-reported in the `added` bucket

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** risk · **Subsystem:** `output` · **Audit confidence:** high
- **Files:** `packages/output/src/format/baseline-diff.ts:93-115`
- **Code:**
  ```ts
  const currentByFp = new Map<string, Signal>();
  for (const signal of current) {
    ...
    currentByFp.set(signal.fingerprint, signal);
  }
  ```
- **Concern:** set difference correctness / false-missing
- **Trigger:** Two distinct current findings produce the same fingerprint. Fitness's strategy is `sha256(filePath\nruleId\nmessage)` (baseline-strategy.ts) — line/column-excluded by design — so two violations of the same rule with the same message in the same file but on different lines collide. The Map keeps only the last; the diff sees ONE signal for that fingerprint.
- **Expected:** If a file gains N net-new findings that all hash to a fingerprint not in the baseline, the `added` bucket should reflect the new findings so the SARIF/ratchet output surfaces them.
- **Actual:** Only ONE signal per colliding fingerprint reaches `added`/`unchanged`. The gate `degraded` flag stays correct (added is non-empty), but the reported `added` set (which drives SARIF re-render and any per-finding output) silently omits the sibling occurrences. Symmetrically, a brand-new second occurrence whose fingerprint already matches a baseline row is bucketed `unchanged` and never surfaces as net-new.
- **Why it matters:** The net-new ratchet's job is to surface every net-new finding on a PR. Collapsing by fingerprint hides additional occurrences of an already-keyed finding, so reviewers may not see all new alerts. The collision is intrinsic to the line-excluding fitness strategy, but diffBaseline is where the lossy collapse happens.
- **Recommendation:** Either document that one signal per fingerprint is intentional (and confirm consumers only need one representative), or key the diff on a richer composite (fingerprint + line/col) for the OUTPUT buckets while keeping the fingerprint for the gate decision. At minimum, count occurrences so the ratchet can report 'N new findings sharing fingerprint X'.
- **Proving test:** diffBaseline([sig('fp1', 'r', 'fileA.ts', line:10), sig('fp1', 'r', 'fileA.ts', line:50)], []) where both share fingerprint 'fp1' — assert added.length; currently it is 1, dropping the second occurrence.

#### 70. SessionRepo.save throws NOT NULL constraint when payload is null (or any falsy non-undefined value), aborting the whole save transaction

- **Status:** 🔴 LIVE · **Severity:** medium · **Kind:** bug · **Subsystem:** `targeting-contracts-session` · **Audit confidence:** high
- **Files:** `packages/session-store/src/session-repo.ts:54-62`, `packages/session-store/src/schema/sessions.ts:33-39`
- **Code:**
  ```ts
  if (session.payload !== undefined) {
    tx.insert(sessionToolPayload)
      .values({ sessionId: session.id, tool: session.tool, payload: session.payload })
      .run();
  }
  ```
- **Concern:** JSON column ser/deser + bad validation: guard predicate contradicts the column's NOT NULL constraint
- **Trigger:** A tool (notably a third-party tool, which CLAUDE.md explicitly supports via discoverToolPackages) saves a StoredSession whose payload is the JS value null (a valid `unknown` JSON value). `session.payload !== undefined` is true for null, so the code attempts to insert payload:null into `sessionToolPayload.payload`, declared `text('payload', { mode:'json' }).notNull()`.
- **Expected:** Either skip the payload row when there is no meaningful detail (treat null like undefined), or persist JSON null and round-trip it back as null.
- **Actual:** better-sqlite3 raises `SqliteError: NOT NULL constraint failed: session_tool_payload.payload`. Because the insert runs inside `this.datastore.transaction(...)`, the whole transaction rolls back — the `sessions` row is NOT persisted either, and `save()` rethrows, crashing the run's session-persist step. Proven by probe (see test).
- **Why it matters:** A run that produced a valid result fails to persist any session at all, and surfaces a cryptic SQLite error. StoredSession.payload is typed `unknown` and documented 'Absent for tools that persist no detail' — but `null` is not `undefined`, so a perfectly legal payload value silently violates the storage contract. The contract surface (contracts) and the persistence layer disagree on what 'no payload' means.
- **Recommendation:** Change the guard to treat null as 'no payload' (e.g. `if (session.payload != null)`), OR make the column nullable and round-trip null through hydrateSession. Treating null like undefined is the smaller change and matches the documented 'Absent' semantics.
- **Proving test:** Memory-backed repo: `repo.save({ id:'x', tool:'fit', timestamp:'2026-06-12T00:00:00.000Z', cwd:'/tmp', score:100, passed:true, durationMs:10, payload:null })`. Today it throws `NOT NULL constraint failed: session_tool_payload.payload`. After the fix, save succeeds and `repo.get('x')` returns the session with `payload` absent (and the sessions row persisted).

### LOW

#### 71. Display test asserts the wrong (unprefixed) map key and never verifies the fold, masking the dead-display bug

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `checks-langs` · **Audit confidence:** high
- **Files:** `packages/fitness/checks-python/src/__tests__/display.test.ts:6-8`
- **Code:**
  ```ts
  it('maps the no-bare-except slug to its [icon, name] tuple', () => {
    expect(checkDisplay['no-bare-except']).toEqual(['🐍', 'No Bare Except']);
  });
  ```
- **Concern:** Test gap — test reinforces an incorrect key and never exercises applyCheckDisplay end-to-end
- **Trigger:** This test passes today even though the icon/name never reach any shipped check, because it only inspects the raw map under the wrong key 'no-bare-except' (real slug is 'python-no-bare-except').
- **Expected:** A test should assert that the exported `checks` carry the authored icon/displayName (i.e. that applyCheckDisplay matched the slug), catching the key/slug mismatch.
- **Actual:** The test only checks the map literal under key 'no-bare-except', which is never used by applyCheckDisplay (it keys on the prefixed slug). It is green while the display is broken, and it cements the wrong unprefixed-key convention. checks-go/java/cpp/rust have no display test at all.
- **Why it matters:** This is exactly the test that should have caught Finding 1; instead it provides false confidence. The other four packs have zero coverage of display folding.
- **Recommendation:** Replace/augment with an assertion against the folded `checks` export (config.icon/config.displayName per real slug) in all five packs.
- **Proving test:** `import { checks } from '../index.js'; expect(checks.find(c => c.config.slug==='python-no-bare-except')?.config.displayName).toBe('No Bare Except');` — fails today, passes after Finding 1 fix.

#### 72. _public-api-graph: module-level `surfaceCache` is never invalidated — stale results across runs in a long-lived process

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `checks-universal` · **Audit confidence:** medium
- **Files:** `packages/fitness/checks-universal/src/checks/documentation/_public-api-graph.ts:31`, `packages/fitness/checks-universal/src/checks/documentation/_public-api-graph.ts:91-101`
- **Code:**
  ```ts
  const surfaceCache = new Map<string, PackagePublicSurface | null>();
  ...
  const cached = surfaceCache.get(packageRoot);
  if (cached !== undefined) return cached;
  ```
- **Concern:** shared mutable module state / cache consistency across runs (contradicts the RunScope no-module-singleton invariant)
- **Trigger:** Two analyses of the same `packageRoot` within one Node process where files changed between them (SaaS-mode/embedded long-lived process, watch mode, or a test that mutates package.json/barrels between runs without calling `_resetPublicApiGraphCache`).
- **Expected:** Per CLAUDE.md, per-run-derived state lives on RunScope and is reset between invocations; the published-surface set reflects current file contents.
- **Actual:** `surfaceCache` is a process-global keyed only by absolute package root, only cleared by the test-only `_resetPublicApiGraphCache()`. A second run reuses the first run's surface even if `package.json#exports` or re-export barrels changed, so `public-api-jsdoc` can scope to a stale surface (false positives/negatives). Within a single `fit` run it is benign (files are stable), but it violates the documented isolation contract and breaks under SaaS/watch reuse.
- **Why it matters:** The project mandates SaaS-ready behavior and forbids module-level mutable per-run state; a stale cache silently changes which files the JSDoc gate enforces.
- **Recommendation:** Move the cache onto RunScope (like `filterContent` was folded into `scope.parseCache`), or key it on package.json mtime, or clear it at run boundaries. At minimum document that it requires a fresh process per content change.
- **Proving test:** In one process: compute surface for a package, edit its `package.json#exports` to drop an entry, recompute. Currently returns the old surface; with a scope-bound or mtime-keyed cache it returns the updated surface.

#### 73. Duplicate UUIDs: three check `id`s collide with regex-list pattern `id`s (cosmetic, but defeats the placeholder-id audit intent)

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** improvement · **Subsystem:** `checks-universal` · **Audit confidence:** high
- **Files:** `packages/fitness/checks-universal/src/checks/quality/no-raw-regex-on-code.ts:17`, `packages/fitness/checks-universal/src/checks/quality/no-window-alert.ts:52`, `packages/fitness/checks-universal/src/checks/quality/no-temporary-workarounds.ts:31`, `packages/fitness/checks-universal/src/checks/quality/no-window-alert.ts:60`, `packages/fitness/checks-universal/src/checks/quality/no-compatibility-layer-names.ts:68`, `packages/fitness/checks-universal/src/checks/quality/no-window-alert.ts:68`
- **Code:**
  ```ts
  // no-raw-regex-on-code check id:
  id: '7a0f6bc1-f4dd-4e55-9628-d797c877c6e0'
  // no-window-alert window-alert PATTERN id (same UUID):
  id: '7a0f6bc1-f4dd-4e55-9628-d797c877c6e0'
  ```
- **Concern:** non-unique identifiers (id reuse across distinct entities)
- **Trigger:** Static inspection: `7a0f6bc1...` is both the `no-raw-regex-on-code` check id and the `window-alert` pattern id; `09a93ec8...` is both the `no-temporary-workarounds` check id and the `window-confirm` pattern id; `e39edca8...` is both the `no-compatibility-layer-names` check id and the `window-prompt` pattern id.
- **Expected:** Every check id (and ideally every pattern id) is globally unique, as `no-placeholder-check-ids` and the contract intend.
- **Actual:** The IDs are reused. This is currently inert because the check registry keys on SLUG, not id, and regex-list pattern ids are descriptive-only metadata not emitted in output. But it is a latent hazard: any future tooling that keys baselines, dedup, or docs on the UUID will conflate unrelated entities.
- **Why it matters:** The repo has an explicit `no-placeholder-check-ids` guard and treats stable ids as contract surface; silently-shared UUIDs undermine that and will bite if id ever becomes the registry/baseline key.
- **Recommendation:** Regenerate fresh UUIDs for the three colliding pattern ids in `no-window-alert.ts`, and add a dogfood test asserting global uniqueness of all `id:` literals (check ids + pattern ids) across the pack.
- **Proving test:** Add a test that greps all `id:` UUID literals in `checks-universal/src/checks/**` and asserts `new Set(ids).size === ids.length`. It fails today on the three collisions listed.

#### 74. No test coverage for sessions show --filter logic (errors-only / warnings-only / top:N)

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** improvement · **Subsystem:** `cli-commands-host` · **Audit confidence:** high
- **Files:** `packages/cli/src/commands/session-show.ts:136-177`, `packages/cli/src/__tests__/session-show.test.ts:134-356`
- **Code:**
  ```ts
  const originalSignalCount = replay.envelope.signals.length;
  const filteredReplay = opts.filters?.length
    ? applyFiltersToReplay(resolved.session, replay, opts.filters)
    : replay;
  ```
- **Concern:** Critical behavior (the documented agent-ergonomics filter) has zero unit coverage
- **Trigger:** Any change to applyFiltersToReplay / severityRank.
- **Expected:** The severity-filter and top:N ordering logic is pinned by tests covering each filter value and severity rung.
- **Actual:** session-show.test.ts exercises only resolution/replay/error paths; grep for 'errors-only', 'warnings-only', 'top:', 'critical' in the test file returns nothing. The filter code (including the severity-rung bug above) is entirely untested, so the bug would not be caught by CI.
- **Why it matters:** The filter is the surface agents use to get focused historical results; a regression there ships silently. The missing coverage is also why the critical/low rung bug went unnoticed.
- **Recommendation:** Add unit tests for applyFiltersToReplay covering errors-only, warnings-only, top:N composition, and the empty-after-filter case, asserting against all four SignalSeverity values.
- **Proving test:** Add `describe('applyFiltersToReplay')` cases: errors-only keeps critical+high; warnings-only keeps medium+low; top:2 over [critical,high,medium] returns [critical,high] in that order; errors-only + top:1 returns the single highest error.

#### 75. sessions show top:N uses the FIRST top: filter, contradicting its own 'last filter wins' comment

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** bug · **Subsystem:** `cli-commands-host` · **Audit confidence:** high
- **Files:** `packages/cli/src/commands/session-show.ts:154-156`
- **Code:**
  ```ts
  // Apply top:N (last filter wins for simplicity; or take min if multiple).
  const topFilter = filters.find((f) => f.startsWith('top:'));
  ```
- **Concern:** Behavior contradicts documented intent
- **Trigger:** `opensip sessions show <id> --filter top:50 --filter top:5` (or any two top: filters).
- **Expected:** Per the inline comment, the last top: filter (top:5) wins.
- **Actual:** Array.prototype.find returns the FIRST match (top:50), so the first filter wins, not the last. The result has up to 50 signals when the user's most recent intent was 5.
- **Why it matters:** Low impact (agents rarely pass two top: filters), but it is a concrete code-vs-documented-behavior mismatch that will surprise anyone who reads the comment and relies on it. It also means filter composition is order-sensitive in an undocumented way.
- **Recommendation:** Either use `filters.filter(f => f.startsWith('top:')).at(-1)` to make last-wins true, or take the minimum N across all top: filters and fix the comment to match. Reject/validate malformed top: values explicitly.
- **Proving test:** filters=['top:50','top:5'] over a 10-signal envelope should return 5 signals (last wins); current code returns 10 (min(50,10)).

#### 76. completion long-flag extraction regex silently truncates any flag containing a digit or uppercase letter

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `cli-commands-host` · **Audit confidence:** high
- **Files:** `packages/cli/src/commands/completion.ts:105-108`, `packages/cli/src/commands/completion.ts:79-84`
- **Code:**
  ```ts
  export function extractLongFlag(flags: string): string | undefined {
    const match = /--[a-z][a-z-]*/.exec(flags);
    return match ? match[0] : undefined;
  }
  ```
- **Concern:** Generated completion script can drift from the real flag surface for non-lowercase-hyphen flags
- **Trigger:** Any current/future command option whose long flag contains a digit or uppercase letter, e.g. `--p95`, `--maxAge`, `--http2`.
- **Expected:** extractLongFlag('--p95-latency') === '--p95-latency'.
- **Actual:** The character class is `[a-z][a-z-]*`, so `--p95-latency` extracts `--p` and `--maxAge` extracts `--max`. The emitted bash/zsh/fish completion would offer a truncated, non-existent flag. All flags in today's surface are lowercase-hyphen so it works now; the contract comment for the function even acknowledges short-only flags but not digit/uppercase.
- **Why it matters:** Completion is a non-critical path, but the module's stated guarantee is 'the script can never drift from the real command surface' — this regex quietly breaks that guarantee for a common flag-naming style (versioned protocol flags, camelCase). A drift test that only checks lowercase flags would not catch it.
- **Recommendation:** Broaden the regex to `/--[A-Za-z][A-Za-z0-9-]*/` (the GNU long-option grammar) so digits/uppercase are preserved, and add a drift-test fixture flag containing a digit.
- **Proving test:** expect(extractLongFlag('--p95-latency')).toBe('--p95-latency'); expect(extractLongFlag('-m, --maxAge <n>')).toBe('--maxAge').

#### 77. plugin add against a project with no config writes a minimal plugins-only config lacking targets/schemaVersion

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `cli-commands-host` · **Audit confidence:** medium
- **Files:** `packages/cli/src/commands/plugin.ts:211-218`, `packages/cli/src/commands/plugin/config-edit.ts:38-43`
- **Code:**
  ```ts
  addToConfigPluginList(resolveProjectPaths(cwd).configFile, domain, outcome.installedName);
  ...
  if (!existsSync(configPath)) {
    if (op === 'remove') return false;
    writeFileSync(configPath, `plugins:
    ${domain}:
      - "${name}"
  `, 'utf8');
    return true;
  }
  ```
- **Concern:** Creates a partial config that omits the targets/schemaVersion the rest of the tooling expects
- **Trigger:** `opensip plugin add <fit-pack>` run in a directory that has never been `init`-ed (no opensip-cli.config.yml).
- **Expected:** Either refuse with 'run opensip init first', or write a config that the next `fit` run can actually use (targets present).
- **Actual:** config-edit writes a config containing only `plugins:` — no `targets:`, no `schemaVersion`. The composer treats host blocks as optional and the schemaVersion reader defaults absent→1, so it does not hard-fail, but the resulting config has no file targets, so the very plugin just installed has nothing to scope against on the next run. The user is left with a half-formed config that looks initialized but isn't.
- **Why it matters:** Silent creation of a degraded config undermines the documented init flow (init is supposed to be the thing that writes targets). It is reachable whenever plugin add is run before init, and the failure is silent (no warning).
- **Recommendation:** In pluginAdd, when the config file does not exist, return a clear error directing the user to run `opensip init` first (the plugin install can still be recorded, but surface the missing-config condition rather than fabricating a targetless config).
- **Proving test:** In a temp dir with no opensip-cli.config.yml, call pluginAdd('@x/pack', dir, 'fit', layouts); assert it either errors with an 'init first' message or the written config contains a `targets:` block — currently it silently writes a plugins-only document.

#### 78. `sessions purge --older-than 0 --yes` deletes ALL sessions despite a selective-purge flag value

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `cli-commands-mount` · **Audit confidence:** high
- **Files:** `packages/cli/src/commands/host-subcommand-groups.ts:188-194`, `packages/cli/src/commands/clear.ts:79-84`
- **Code:**
  ```ts
  // parser accepts 0:
    if (Number.isNaN(n) || n < 0) { throw ... }
  // handler treats 0 as 'delete everything':
    if (opts.olderThan !== undefined && opts.olderThan > 0) {
      const cutoff = new Date(Date.now() - opts.olderThan * 24 * 60 * 60 * 1000);
      deletedCount = repo.purge(cutoff);
    } else {
      deletedCount = repo.clearAll();
    }
  ```
- **Concern:** validation/boundary value with destructive side effect
- **Trigger:** `opensip sessions purge --older-than 0 --yes`
- **Expected:** A caller passing an explicit `--older-than` value expects a bounded/selective purge, or a rejection of a meaningless value.
- **Actual:** `parseOlderThanDays` accepts 0 (only `< 0` is rejected). The handler's `olderThan > 0` guard makes 0 fall through to `repo.clearAll()` — a full wipe. With `--yes`, no confirmation prompt is shown (the interactive prompt would have warned 'delete ALL session data', which is itself only coincidentally consistent because 0 is falsy in the prompt's ternary).
- **Why it matters:** A destructive full delete triggered by what looks like a bounded filter is a foot-gun; the value boundary (0 accepted by the parser but reinterpreted as 'all' by the handler) is an unstated invariant that a small refactor of either side could break into silent data loss.
- **Recommendation:** Either reject 0 in `parseOlderThanDays` (require `n >= 1`), or make the handler treat `olderThan === 0` explicitly. Align the parser's accepted domain with the handler's interpretation.
- **Proving test:** Seed N sessions, run `executeClear({ olderThan: 0, yes: true, datastore })`, and assert the intended semantics (currently deletes all N).

#### 79. Config validation error summary collapses Zod record-key issues, hiding the real reason

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** improvement · **Subsystem:** `config` · **Audit confidence:** high
- **Files:** `packages/config/src/composer.ts:100-107`
- **Code:**
  ```ts
  const summary = issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(document root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
  ```
- **Concern:** Diagnostic quality / swallowed nested validation detail
- **Trigger:** A malformed `targets:` key (not kebab-case), e.g. `targets: { Bad_Key: {...} }`. Zod 4 emits an `invalid_key` issue whose top-level `message` is the generic 'Invalid key in record' and whose specific reason ('target name must be kebab-case') lives in a nested `issues` array that this summary never reads.
- **Expected:** The thrown ConfigurationError message should tell the user WHY the key is invalid (kebab-case requirement), so they can fix it.
- **Actual:** The user sees `targets.Bad_Key: Invalid key in record` — the actionable regex message is dropped. The structured `issues` are still attached to the error for downstream consumers, but the human-facing summary is unhelpful for the most common targets misconfiguration.
- **Why it matters:** Config errors are user-facing and must be actionable; a generic message turns a one-line fix into a guessing game. Low severity (the full issues are attached), but it degrades the strict-validation UX that ADR-0023 is built around.
- **Recommendation:** When an issue has a nested `issues` array (record key/element errors), recurse into it to surface the inner message, or special-case `code === 'invalid_key'` to append the inner reason.
- **Proving test:** validateConfigDocument(composeConfigSchema(hostConfigDeclarations()), { targets: { Bad_Key: { description: 'x', include: ['**'] } } }) — assert the thrown error.message contains 'kebab-case', not just 'Invalid key in record'.

#### 80. isKnownDirectiveLine only recognizes // and /* openers, so stacked #/<!-- directives are not skipped to the real next-line target

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `core-lang-signals` · **Audit confidence:** high
- **Files:** `packages/core/src/signals/suppress.ts:169-178`
- **Code:**
  ```ts
  function isKnownDirectiveLine(line: string): boolean {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('//') && !trimmed.startsWith('/*')) return false;
    const content = trimmed.slice(2).trimStart();
    ...
  ```
- **Concern:** Inconsistent opener set — the stacked-directive skip logic recognizes only C-family comment openers, while the directive scanner itself (extractDirectiveId) and the documented opener set include `#` (shell/YAML/Python/TOML/Dockerfile) and `<!--` (Markdown/HTML).
- **Trigger:** A `@fitness-ignore-next-line` directive in a `#`-comment language (YAML/shell/Python) stacked above another `#`-comment linter directive, e.g.\n`# @fitness-ignore-next-line my-check`\n`# noqa`\n`actual_code`
- **Expected:** The skip loop walks over the `# noqa` neighbor and lands the suppression on `actual_code` (line 3), matching the documented stacked-directive behavior across all four opener families.
- **Actual:** `isKnownDirectiveLine` returns false for `# noqa` (only `//`/`/*` are checked), so the directive targets the `# noqa` line (line 2) instead of `actual_code` (line 3); the suppression silently misses the intended target.
- **Why it matters:** Inline suppression in #-comment and HTML-comment files is a documented, supported feature (docs/public/20-fit/03-ignore-directives.md:40-49). A waiver in those files that happens to stack above another comment directive silently fails, leaking the finding.
- **Recommendation:** Derive the leading-comment check in `isKnownDirectiveLine` from the shared `COMMENT_OPENERS`/`stripCommentOpener` table (slicing the matched opener's actual length) rather than hardcoding `//`/`/*` and `slice(2)`, so all four opener families are handled consistently.
- **Proving test:** `scanSuppressionDirectives('# @fitness-ignore-next-line my-check\n# noqa\nx = eval(s)', FITNESS_KEYWORDS).lineIgnoredIds` MUST map line 3 → {my-check}; currently it maps line 2.

#### 81. C/C++ line-continuation in // comments not recognized on CRLF files (backslash-lookback ignores the \r before \n)

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `core-lang-signals` · **Audit confidence:** high
- **Files:** `packages/core/src/languages/strip-scanners.ts:131-143`, `packages/core/src/languages/strip-scanners.ts:157-169`
- **Code:**
  ```ts
  if (src[i] === '
  ') {
    if (allowLineContinuation && hasUnescapedTrailingBackslash(src, bodyStart, i)) { i++; continue; }
    break;
  }
  ...
  let k = newlinePos - 1;
  while (k >= bodyStart && src[k] === '\\') { count++; k--; }
  ```
- **Concern:** Newline/encoding edge — the line-splice detector looks at the character immediately before `\n`, which on a CRLF file is `\r`, not the backslash.
- **Trigger:** A C/C++ source file saved with CRLF line endings containing a `//` comment ending in a backslash line-splice: `// long comment \\\r\nstill comment`. lang-cpp calls `scanLineComment(..., { allowLineContinuation: true })`.
- **Expected:** Per C/C++ phase-2 translation the `\<newline>` splices the comment onto the next physical line, so the strip pass should treat the next physical line as comment content too.
- **Actual:** `hasUnescapedTrailingBackslash` inspects `src[newlinePos-1]` which is `\r`; the count is 0 (even) so no splice is detected and the next physical line is treated as code. A pattern check could then match real findings inside what is actually comment text (false positives) on Windows-authored C/C++ files.
- **Why it matters:** Affects correctness of string/comment stripping for cross-language checks (checks-universal etc.) on CRLF-saved C/C++ sources, producing spurious findings inside line-continued comments.
- **Recommendation:** In `hasUnescapedTrailingBackslash`, start the back-walk at the last non-`\r` character before the newline (skip a single trailing `\r`), or normalize line endings before the strip scan. Add a CRLF regression test in the cpp strip suite.
- **Proving test:** `scanLineComment('// c \\\r\nstillcomment', 0, { allowLineContinuation: true }).end` should point past `stillcomment` (splice honored); currently it stops at the first `\n`.

#### 82. A built package whose `main`/`exports` points at a missing file is rejected with the "resolves outside package directory" message, never the intended "entry point not found"

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** bug · **Subsystem:** `core-plugins` · **Audit confidence:** high
- **Files:** `packages/core/src/plugins/discover.ts:216-236`
- **Code:**
  ```ts
  if (!isPathInside(resolved.entry, packageDir)) {
    logger.warn({ ..., reason: 'entry point resolves outside package directory', name, entry: resolved.entry });
    return undefined;
  }
  
  if (!existsSync(resolved.entry)) {
    logger.debug({ ..., reason: 'entry point not found', ... });
    return undefined;
  }
  ```
- **Concern:** Misleading error handling / dead diagnostic branch
- **Trigger:** A declared plugin package is installed but its `package.json` `main` (or `exports['.']`) points at a file that does not exist on disk (e.g. `main: './nonexistent.js'`, or a package shipped without its build output). Verified `realpathSync` throws ENOENT for a missing file.
- **Expected:** The package is skipped with the `entry point not found` debug diagnostic at line 227-235.
- **Actual:** `isPathInside(resolved.entry, packageDir)` runs FIRST (line 216) and `realpathSync(resolved.entry)` throws ENOENT for the missing entry, so `isPathInside` returns false → the WARN-level `entry point resolves outside package directory` fires and the function returns. The `existsSync(resolved.entry)` branch (the intended diagnostic for this case) is dead for any missing-but-in-bounds entry — it can only fire for an entry that exists but is outside (impossible, since being outside would have already returned).
- **Why it matters:** Operators see a security-flavored WARN ("resolves outside package directory") for a benign "forgot to build" / "wrong main" misconfiguration, masking the real cause. The carefully written `entry point not found` branch is effectively unreachable.
- **Recommendation:** Check `existsSync(resolved.entry)` BEFORE the containment check, OR have `isPathInside` distinguish ENOENT from a real escape. Order should be: exists? → inside? → admit.
- **Proving test:** Install a declared plugin with `main: './nonexistent.js'`; spy on logger; assert the diagnostic is `entry point not found` (debug), not `entry point resolves outside package directory` (warn). discover.test.ts:195 only asserts `[]` and misses this.

#### 83. Package entry resolution ignores top-level conditional exports sugar (`exports: { import, require, node }` without a `.` key)

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `core-plugins` · **Audit confidence:** high
- **Files:** `packages/core/src/plugins/package-entry.ts:85-100`, `packages/core/src/plugins/package-entry.ts:67`
- **Code:**
  ```ts
  function resolveEntryFromExportsField(exportsField) {
    if (typeof exportsField === 'string') return exportsField;
    if (!exportsField || typeof exportsField !== 'object') return undefined;
    if (!('.' in exportsField)) return undefined;   // <-- bails on top-level conditions
    ...
  ```
- **Concern:** Incomplete API contract (Node exports resolution) → wrong/empty discovery
- **Trigger:** A discovered plugin/tool package declares Node's top-level-conditions sugar, e.g. `"exports": { "import": "./dist/index.js", "require": "./dist/index.cjs" }` (a valid Node shorthand for `{ ".": { ... } }`), and has no `main` field.
- **Expected:** Resolution selects `exports.import` (matching Node's behavior the file claims to mirror): `./dist/index.js`.
- **Actual:** `resolveEntryFromExportsField` returns `undefined` because there is no `'.'` key; the caller then falls back to `pkg.main ?? './index.js'`. With no `main`, it resolves to `./index.js`, which typically does not exist for a `dist/`-built package → the plugin/tool is silently skipped (or, for the tool path, mis-resolved).
- **Why it matters:** A third-party plugin or tool published with the (Node-valid) top-level-conditions exports map fails to load with no clear reason, contradicting the file's documented goal of matching Node's exports resolution.
- **Recommendation:** When `exports` is an object with no `'.'` key but with condition keys (`import`/`default`/`node`/`require`), treat the object itself as the `.` condition map (Node's documented sugar). Detect "all keys start with non-`.`" to disambiguate from a subpath map.
- **Proving test:** `resolvePackageEntryPoint` over a dir whose package.json has `{"name":"p","exports":{"import":"./dist/index.js"}}` (no `main`) and a real `./dist/index.js` — assert `entry` ends with `dist/index.js`, not `index.js`.

#### 84. defineCommand does not detect option-flag collisions with common flags or duplicate option flags

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** improvement · **Subsystem:** `core-tools` · **Audit confidence:** high
- **Files:** `packages/core/src/tools/command-spec.ts:239-286`
- **Code:**
  ```ts
  // Validation is structural and pure
  // — it catches authoring mistakes at construction time:
  //
  // - `name` non-empty
  // - `description` non-empty
  // - every `commonFlags` key is a valid {@link CommonFlagKey}
  // - no duplicate `commonFlags` keys
  // - `handler` is a function
  ```
- **Concern:** Validation gap — authoring mistake surfaces late as an opaque Commander throw
- **Trigger:** A tool declares `commonFlags: ['json']` AND an `OptionSpec { flag: '--json' }`, or declares two `OptionSpec`s with the same `flag`, or a long flag that overlaps a common flag's long name (e.g. `--cwd`).
- **Expected:** defineCommand's stated purpose is to 'catch authoring mistakes at construction time'. A duplicate/colliding flag is exactly such a mistake and should be caught here (or be explicitly out of scope).
- **Actual:** defineCommand only checks commonFlags keys for unknown/duplicate values; it never inspects `options[].flag` for collisions with commonFlags or with each other. The collision surfaces only at mount, where `applyCommonFlags` adds `--json` and then `cmd.addOption(new Option('--json', ...))` causes Commander to throw or shadow — a late, opaque failure far from the authoring site.
- **Why it matters:** Low impact today (first-party specs are correct and TS-typed), but the contract advertises construction-time validation, so an author reasonably assumes a colliding flag would be caught. For untyped .mjs plugins there is no compile-time guard at all, making the late Commander throw the only signal.
- **Recommendation:** In defineCommand, collect the long-flag tokens from `spec.commonFlags` (via the COMMON_FLAG_KEYS→long-name mapping, or a small static map kept in core) plus each `options[].flag`, and throw on any duplicate long token. Keep it pure (no Commander) — just string parsing of the flag declarations.
- **Proving test:** `defineCommand(baseSpec({ commonFlags: ['json'], options: [{ flag: '--json', description: 'x' }] }))` should throw 'duplicate flag --json' after the fix; today it returns the spec and the collision only manifests as a Commander error at mount.

#### 85. openCodePathsSession toggles only the sessions/explore subtabs active, leaving a previously-active catalog/recipes subtab also marked active (two active subpanels)

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** bug · **Subsystem:** `dashboard` · **Audit confidence:** high
- **Files:** `packages/dashboard/src/code-paths.ts:399-406`
- **Code:**
  ```ts
  const sessionsSub = panel.querySelector('.subtab[data-subtab="sessions"]');
  const exploreSub = panel.querySelector('.subtab[data-subtab="explore"]');
  if (sessionsSub) sessionsSub.classList.add('active');
  if (exploreSub) exploreSub.classList.remove('active');
  if (sessionsPanel) sessionsPanel.classList.add('active');
  if (explorePanel) explorePanel.classList.remove('active');
  ```
- **Concern:** invalid UI state transition: the Code Paths tab now has four subtabs (sessions, catalog, recipes, explore — see code-paths.ts:204-241), but this cross-tab activator only clears `explore` and `sessions`, not `catalog`/`recipes`.
- **Trigger:** On the Code Graph tab, click the Catalog (or Recipes) subtab so it becomes active. Then go to Overview and click a graph session row, which routes through activateTabForSession → openCodePathsSession.
- **Expected:** Exactly one subtab/subpanel active (Sessions) after the deep-link navigation.
- **Actual:** Both the Sessions subpanel and the still-active Catalog/Recipes subpanel carry the `active` class, so two subpanels render simultaneously and two subtab headers appear selected.
- **Why it matters:** The activator is the documented cross-tool deep-link path from Overview; leaving stale active state produces a visibly broken panel for graph sessions, the exact flow this function exists to support.
- **Recommendation:** Clear active state across ALL subtabs/subpanels generically before activating sessions, e.g. `panel.querySelectorAll('.subtab').forEach(t => t.classList.remove('active'))` and `panel.querySelectorAll('.subtab-panel').forEach(p => p.classList.remove('active'))`, then add `active` to the sessions subtab/panel — mirroring renderSubtabBar's own click handler (subtab-bar.ts:63-66).
- **Proving test:** jsdom: render the Code Paths panel, click the `catalog` subtab to mark it active, then invoke openCodePathsSession(sessionId); assert exactly one `.subtab.active` and one `.subtab-panel.active` exist and both are the sessions ones (currently catalog stays active too).

#### 86. Findings-count column computes sm.errors + (sm.warnings || 0) but does not guard sm.errors, rendering 'NaN' for any partial summary payload

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `dashboard` · **Audit confidence:** medium
- **Files:** `packages/dashboard/src/overview.ts:81`, `packages/dashboard/src/sessions.ts:74`
- **Code:**
  ```ts
  row.appendChild(el('td', {text: ''+(sm.errors + (sm.warnings || 0))}));
  ```
- **Concern:** null/undefined mishandling in number formatting (NaN).
- **Trigger:** A session whose `payload.summary` object exists but omits `errors` (a third-party tool, a legacy/partial row, or a future tool that records `{total,passed,failed}` only). The fallback default object at overview.ts:55 / sessions.ts:58 only applies when `payload.summary` is entirely falsy, so a present-but-partial summary skips it; `undefined + (undefined||0)` → NaN.
- **Expected:** The Findings column shows a finite count (0 when no error/warning counts are recorded).
- **Actual:** The cell renders the literal text 'NaN'. Note `sm.warnings` is defensively guarded with `|| 0` on the same line while `sm.errors` is not, so the asymmetry looks accidental rather than intentional.
- **Why it matters:** The dashboard is the cross-tool presentation owner and explicitly reads tool-owned opaque payloads structurally (DashboardInput docs); a partial summary from any non-fitness/non-graph tool surfaces as a garbage 'NaN' count in the headline activity table. First-party fitness/graph payloads always include `errors`, so this does not bite today, but the contract (`payload: unknown`) permits partial summaries.
- **Recommendation:** Guard both terms symmetrically: `''+((sm.errors || 0) + (sm.warnings || 0))`.
- **Proving test:** Render the overview/session table with a session whose payload is `{summary:{total:1,passed:1,failed:0}}` (no errors/warnings keys); assert the Findings cell textContent is '0', not 'NaN'.

#### 87. defineRankedView splices config.help via JSON.stringify into an inline <script> without the script-context escape applied to every other embedded value

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `dashboard` · **Audit confidence:** medium
- **Files:** `packages/dashboard/src/code-paths/view-template.ts:183`, `packages/dashboard/src/code-paths/view-template.ts:295`
- **Code:**
  ```ts
  const helpJson = JSON.stringify(config.help);
  ...
    help: ${helpJson},
  ```
- **Concern:** ser/deser + script-context escaping: JSON.stringify does not escape `<`, so a literal `</script>` inside any help string would terminate the surrounding inline <script>. Every other JSON-into-<script> path in this package routes through escapeForScriptContext (generator.ts:57-59) precisely to prevent this; this one does not.
- **Trigger:** Only triggers if a RankedViewConfig.help section body/heading/title ever contains the substring `</script>`. Today all help content is static first-party copy (view-distribution.ts), so it is not exploitable now.
- **Expected:** All JSON embedded inside an inline <script> is run through the same `<`/`>` script-context escape so embedded content can never close the script element.
- **Actual:** `config.help` is embedded raw via JSON.stringify; it relies on the unstated invariant that no help string ever contains `</script>`. A small edit (adding HTML-ish help copy, or a future third-party ranked view) breaks the page silently.
- **Why it matters:** Inconsistent escaping is a latent markup-breakage / injection footgun in a file whose whole job is emitting <script> source; the codebase already centralizes the fix and this site bypasses it.
- **Recommendation:** Run helpJson through the same script-context escape used in generator.ts (escape `<`/`>` to `<`/`>`) before splicing, or share a single escaping helper across the package.
- **Proving test:** Emit defineRankedView with `help.sections[0].body = 'see </script> here'`; assert the emitted string does not contain a raw `</script>` (it should be escaped).

#### 88. isNativeBindingError can infinite-loop on a circular Error.cause chain

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `datastore` · **Audit confidence:** medium
- **Files:** `packages/datastore/src/factory.ts:119-129`
- **Code:**
  ```ts
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === 'ERR_DLOPEN_FAILED') return true;
    ...
  }
  ```
- **Concern:** Resource/liveness: the cause-chain walk has no cycle guard or depth bound.
- **Trigger:** An Error whose `.cause` chain is circular (a.cause = b, b.cause = a). Rare but constructible (and some libraries wrap-and-rethrow in ways that can create cycles). Reached on every SQLite open failure (factory.ts:52 -> openFailureMessage -> isNativeBindingError).
- **Expected:** isNativeBindingError terminates for any input.
- **Actual:** A circular cause chain spins forever, hanging the CLI during error reporting (the very moment the user is already failing to open the datastore).
- **Why it matters:** Low likelihood but a hang during error handling is hard to diagnose. Cheap to make robust.
- **Recommendation:** Bound the walk with a visited Set or a max-depth counter (e.g. 32 hops) before falling through to return false.
- **Proving test:** const a = new Error('a'); const b = new Error('b'); a.cause = b; b.cause = a; expect(() => isNativeBindingError(a)).not.toHang() — add a depth/visited guard and assert it returns within bounds.

#### 89. defineRegexListCheck emits 0-based column (match.index) while other position-aware checks and SARIF expect 1-based columns

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `fit-framework-define` · **Audit confidence:** high
- **Files:** `packages/fitness/engine/src/framework/define-regex-list-check.ts:223-231`
- **Code:**
  ```ts
  violations.push({
    line: lineNum,
    column: match.index,
    message: pattern.message,
    ...
  });
  ```
- **Concern:** Off-by-one in line/column mapping (0-based vs 1-based)
- **Trigger:** Any regex-list pattern that matches at a non-zero offset within a line; e.g. a match starting at character position 5 reports column 5 instead of 6.
- **Expected:** Columns reported by checks should be 1-based to match SARIF region.startColumn semantics and the TS-AST checks in this repo that use `character + 1`.
- **Actual:** match.index is 0-based, so reported columns are off by one relative to 1-based consumers. A match at the very start of a line yields column 0, which the SARIF emitter (output/format/signal-sarif.ts atLeastOne) drops entirely (degrades to whole-line). The fitness fingerprint is message-hash based (sha256 of filePath\nruleId\nmessage), so this does NOT destabilize the gate, but it produces incorrect column coordinates in SARIF/PR annotations. Note the repo is already inconsistent (many checks-universal regex checks also pass raw match.index), so this helper inherits an existing convention rather…
- **Why it matters:** Inaccurate column coordinates surface at the wrong character on PR diff annotations and any IDE/SARIF consumer; column 0 silently disappears.
- **Recommendation:** Emit `column: match.index + 1` in matchPatternOnLine (and standardize the regex-based checks-universal sites the same way) so columns are uniformly 1-based.
- **Proving test:** Define a regex-list check with regex /BAD/ and run over a line `const x = BAD`. Assert the produced violation.column equals the 1-based index of 'B' (11), not 10; and that a match at column 1 is emitted as 1 (not dropped by SARIF).

#### 90. stripStringsAndComments collapses multi-line template literals, deleting interior newlines and shifting all subsequent line numbers

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `fit-framework-define` · **Audit confidence:** high
- **Files:** `packages/fitness/engine/src/framework/strip-literals.ts:48,92-102`
- **Code:**
  ```ts
  const BACKTICK_RE = /`(?:[^`\\]|\\.)*`/gs;
  ...
  let result = content
    .replaceAll(SINGLE_QUOTE_RE, "''")
    .replaceAll(DOUBLE_QUOTE_RE, '""')
    .replaceAll(BACKTICK_RE, '``');
  ```
- **Concern:** ser/transform error: index/line shift after content rewrite
- **Trigger:** Content containing a multi-line template literal, e.g. const q = `line1\nline2`; passed to stripStringsAndComments (or stripStringLiterals applied to multi-line input). The backtick regex char class `[^`\\]` matches newlines, so the whole literal — including its interior \n characters — is replaced with the two-char `` ``, removing those newlines.
- **Expected:** For a position-shifting transform, the doc on stripStringsAndCommentsPreservingPositions warns this exact hazard breaks getLineNumber(content, idx). Callers that map an index back to a line in the original source must not use stripStringsAndComments.
- **Actual:** stripStringsAndComments deletes newlines inside multi-line template literals, so any index→line mapping done on its output is wrong for everything after such a literal. Current first-party callers only use it as a substring quick-filter gate (.includes('timeout')) and map lines off the ORIGINAL content, so they are not broken today — but the function is exported on the public @opensip-cli/fitness barrel and the contract is undocumented at the function itself, so a future caller that does getLineNumber(stripStringsAndComments(content), idx) gets silently wrong lines.
- **Why it matters:** A wrong line number in a finding misdirects the developer and (for any consumer keying on line) can mis-fingerprint. The footgun is one careless caller away.
- **Recommendation:** Either document on stripStringsAndComments itself that it is index/line-destructive (point callers needing position fidelity to stripStringsAndCommentsPreservingPositions), or make the public barrel export only the position-preserving variant. Optionally make BACKTICK_RE preserve newlines.
- **Proving test:** Assert stripStringsAndComments('a\nconst q = `x\ny`;\nBAD').split('\n') no longer aligns BAD with its original line, demonstrating the shift; and document/guard accordingly.

#### 91. Regex-based comment/string stripper misclassifies regex literals containing // or /* (and template ${} interpolations), risking false negatives

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `fit-framework-define` · **Audit confidence:** medium
- **Files:** `packages/fitness/engine/src/framework/strip-literals.ts:122-225`, `packages/fitness/engine/src/framework/strip-literals.ts:60-85`
- **Code:**
  ```ts
  if (ch === '/' && next === '/') { out.push('  '); inLineComment = true; i += 2; continue; }
  if (ch === '/' && next === '*') { out.push('  '); inBlockComment = true; i += 2; continue; }
  ```
- **Concern:** Code paths contradicting expected behavior (best-effort tokenizer misfires on legal source)
- **Trigger:** A line/file with a JS regex literal whose body contains `//` or `/*`, e.g. const re = /a\/\//; — the tokenizer is not regex-literal-aware, treats the embedded `//` as a line-comment opener, and blanks the remainder of the line as a comment. Similarly, code inside a template ${ ... } interpolation is treated as inside-string by both stripStringsAndCommentsPreservingPositions and isInsideStringLiteral.
- **Expected:** For TS files the canonical guidance (this module's own header + CLAUDE.md) is to prefer the real TS scanner filterContent. The regex stripper is explicitly best-effort, so this is an acknowledged limitation — but callers in checks-typescript (no-unbounded-concurrency.ts) and checks-universal (batch-operations.ts) use it position-preservingly on real TS.
- **Actual:** A regex literal containing `//` causes the rest of the line to be blanked as a comment, so a real violation after the regex on that line is silently dropped (false negative). Template interpolation code is treated as string content, so isInsideStringLiteral(line, idx) returns true for matches inside ${}, also causing the single caller (logger-event-name-format) to skip a real match.
- **Why it matters:** False negatives in gate checks mean violations slip through CI undetected. The trigger pattern (regex literals with embedded slashes) is uncommon but legal and present in real codebases.
- **Recommendation:** For TS-targeted checks, route through filterContent (the position-preserving TS scanner) per the module's own canonical guidance rather than the regex stripper; or add minimal regex-literal awareness to the tokenizer. At minimum, document the regex-literal/interpolation blind spots at the function level so authors choose the right filter.
- **Proving test:** stripStringsAndCommentsPreservingPositions('const re = /a\\/\\//; BAD();') currently blanks 'BAD()' — assert the desired behavior keeps code after the regex literal intact; and assert isInsideStringLiteral('`x ${BAD} y`', indexOfBAD) === false once interpolation-aware.

#### 92. CheckRegistry.has()/find()/getBySlug() return 'not registered' for an ambiguous bare slug that IS registered (under namespaces)

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `fit-framework-define` · **Audit confidence:** medium
- **Files:** `packages/fitness/engine/src/framework/registry.ts:73-80,131-158`
- **Code:**
  ```ts
  has(slug: string): boolean { return this.resolve(slug) !== undefined; }
  ...
  private resolve(slug: string): Check | undefined {
    ...
    if (candidates.length > 1) { logger.warn({...}); return undefined; }
    ...
  }
  ```
- **Concern:** Invalid state reporting / API contract: has() says false for something that exists
- **Trigger:** Two packs register the same bare slug under different namespaces (e.g. ns1:no-foo and ns2:no-foo), then a caller probes registry.has('no-foo') or registry.find('no-foo').
- **Expected:** get('no-foo') correctly throws an ambiguity NotFoundError listing candidates. has()/find() should consistently signal 'exists but ambiguous' rather than 'not registered'.
- **Actual:** resolve() returns undefined on ambiguity (logging a WARN), so has() returns false and find()/getBySlug() return undefined — indistinguishable from 'never registered'. A caller using has() to decide whether to register/override or to gate behavior will treat a genuinely-present (but ambiguous) slug as absent, potentially masking the ambiguity or making a wrong control-flow decision. get() is the only method that surfaces the ambiguity.
- **Why it matters:** Silent false-negative existence checks can lead callers to skip a check, double-register, or take the wrong branch; the WARN is easy to miss and the boolean is what code branches on.
- **Recommendation:** Make has()/find()/getBySlug() ambiguity-aware (e.g. has() returns true when bareSlugIndex has >=1 candidate, and find() either throws like get() or returns a discriminated 'ambiguous' result), so existence checks agree with get()'s view.
- **Proving test:** Register the same bare slug under two namespaces; assert registry.has('slug') === true (or that find() throws the ambiguity error) instead of silently returning false/undefined while get() throws.

#### 93. session.ignoreCounts is read into the result but never assigned — always undefined

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `fit-recipes` · **Audit confidence:** high
- **Files:** `packages/fitness/engine/src/recipes/service.ts:390`, `packages/fitness/engine/src/recipes/service-types.ts:109`
- **Code:**
  ```ts
  ...(session.ignoreCounts ? { ignoreCounts: session.ignoreCounts } : {}),
  ```
- **Concern:** Dead/incomplete field: FitnessRecipeSession.ignoreCounts (the typed {file,line,block,total} breakdown) is declared and conditionally surfaced on FitnessRecipeResult, but nothing in the recipe pipeline ever assigns session.ignoreCounts (only ignoresByTag and totalIgnored are populated).
- **Trigger:** Any run — result.ignoreCounts is always absent.
- **Expected:** Either the per-directive-type ignore breakdown is computed and exposed, or the field is removed so consumers don't assume it can be populated.
- **Actual:** FitnessRecipeResult.ignoreCounts is permanently undefined; any future consumer that branches on it gets the empty path silently.
- **Why it matters:** Low impact today (no current consumer reads result.ignoreCounts — downstream uses per-check cr.ignoredCount), but it is a latent trap: a reviewer/consumer can reasonably assume the breakdown is available and build on always-undefined data.
- **Recommendation:** Populate session.ignoreCounts from the collected directives/ignoresByTag during buildResult, or delete the field from the session and result types until the breakdown is actually produced.
- **Proving test:** Run any recipe with checks that apply @fitness-ignore directives and assert result.ignoreCounts is defined with file/line/block/total. Today it is undefined.

#### 94. validateCheckReferences exact-matches bare checkIds against namespaced keys, emitting spurious 'unknown check' warnings for namespaced plugin checks

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `fit-recipes` · **Audit confidence:** medium
- **Files:** `packages/fitness/engine/src/recipes/service.ts:287-298`, `packages/fitness/engine/src/recipes/check-resolution.ts:85-102`
- **Code:**
  ```ts
  const allSlugs = this.checkRegistry.listSlugs();
  const { missing } = validateCheckReferences(recipe.checks.checkIds, [...allSlugs]);
  if (missing.length > 0) { logger.warn(`Recipe references ${missing.length} unknown check(s)`, ...); }
  ```
- **Concern:** API/identity mismatch: resolveChecks resolves explicit bare slugs to namespaced keys via reverse lookup, but validateCheckReferences does a plain Set.has() exact match. For a check registered under a namespace (e.g. 'mypack:no-eval'), a recipe referencing bare 'no-eval' resolves and runs correctly yet is reported as missing.
- **Trigger:** A check pack registers checks with a namespace (CheckRegistry.register(check, namespace)) and a recipe uses an explicit bare-slug checkId. First-party checks are registered bare so they are unaffected; namespaced plugin packs trigger it.
- **Expected:** The 'unknown check' warning fires only for checkIds that resolve to no registered check.
- **Actual:** A correctly-resolving bare slug is reported as an unknown/missing check (warning only; the check still runs), producing misleading diagnostics.
- **Why it matters:** Low impact (warning only, no selection change), but it can send a contributor chasing a non-existent missing-check problem and erodes trust in the diagnostic.
- **Recommendation:** Validate references using the same resolution used for selection (e.g. check registry.getBySlug/reverse lookup), or compute 'missing' as checkIds whose resolveChecks/resolveExplicit yields nothing, rather than exact-matching against listSlugs().
- **Proving test:** Register a check under namespace 'pack' with slug 'foo', define an explicit recipe with checkIds:['foo'], run it, and assert no 'unknown check' warning is logged while the check still executes. Today the warning fires.

#### 95. Python nested-class methods lose the outer class in enclosingClass/qualifiedName

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `graph-adapter-langs` · **Audit confidence:** high
- **Files:** `packages/graph/graph-python/src/walk.ts:162`, `packages/graph/graph-python/src/walk.ts:207`
- **Code:**
  ```ts
  const childFrame: Frame = { ownerHash: frame.ownerHash, enclosingClass: className };
  ...
    const qualifiedName =
      enclosingClass === null
        ? `${qualifiedBase}.${name}`
        : `${qualifiedBase}.${enclosingClass}.${name}`;
  ```
- **Concern:** Identity collision / wrong metadata
- **Trigger:** A method defined inside a nested class, e.g. `class A:\n  class B:\n    def m(self): ...`. visitClass overwrites enclosingClass to `B`, discarding `A`.
- **Expected:** The method's enclosingClass/qualifiedName should reflect the full nesting (`A.B`), or at minimum not collide with a top-level `class B`'s method `m`.
- **Actual:** enclosingClass=`B`, qualifiedName=`<mod>.B.m`, identical to a separate top-level `class B: def m()` in the same module. The two distinct occurrences become indistinguishable by qualifiedName/enclosingClass.
- **Why it matters:** Lower impact than edge resolution (edges are resolved by simpleName, not qualifiedName), but qualifiedName is used for display, symbol lookup, and SARIF attribution; collisions mislabel findings. The same flattening happens in Java's visitTypeDeclaration (graph-java/src/walk.ts:207) for nested types.
- **Recommendation:** Accumulate the class path in the Frame (e.g. `enclosingClass: frame.enclosingClass ? `${frame.enclosingClass}.${className}` : className`) so nested classes produce dotted qualifiers and stable identities.
- **Proving test:** Walk `class A:\n  class B:\n    def m(self): pass` plus a separate `class B:\n  def m(self): pass`. Assert the two `m` occurrences have distinct qualifiedName values.

#### 96. Go type-only parameters are silently dropped from the param list

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `graph-adapter-langs` · **Audit confidence:** high
- **Files:** `packages/graph/graph-go/src/walk-metadata.ts:97`
- **Code:**
  ```ts
      for (const inner of namedChildrenOf(child)) {
        if (inner.type === 'identifier') {
          out.push({ name: inner.text, optional: false, rest: isRest });
        }
      }
  ```
- **Concern:** Incomplete extraction vs grammar shape
- **Trigger:** A Go function/method with an unnamed (type-only) parameter, e.g. `func f(int) {}` or interface-method signatures `Read([]byte) (int, error)`. The `parameter_declaration` contains only a type node (`type_identifier`, `slice_type`, etc.), no `identifier` child.
- **Expected:** The parameter should be counted (Go permits and uses unnamed params, especially in interface declarations and stub signatures).
- **Actual:** collectParamEntries only pushes when a named-child `identifier` is present, so type-only params yield zero entries — the function's params array undercounts.
- **Why it matters:** params feeds occurrence metadata consumed by rules like wide-function (parameter-count signals). Undercounting params can cause a wide function to escape the wide-function gate. Low severity because unnamed params are uncommon in concrete function bodies, but interface method sets are routinely unnamed.
- **Recommendation:** When a parameter_declaration has no `identifier` children but does have a type, emit one anonymous param entry (e.g. name `_`) so arity is preserved.
- **Proving test:** Walk `func f(int, string) {}`; assert the occurrence has params.length === 2 (currently 0).

#### 97. Go `decodeReceiverTypeNode` returns full text for unrecognized type nodes, polluting the method's enclosingClass

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `graph-adapter-langs` · **Audit confidence:** medium
- **Files:** `packages/graph/graph-go/src/walk-metadata.ts:60`
- **Code:**
  ```ts
    if (node.type === 'generic_type') { ... }
    /* v8 ignore next */
    return node.text;
  ```
- **Concern:** Wrong receiver-type extraction on unexpected grammar shape
- **Trigger:** A receiver type node that is neither `pointer_type`, `type_identifier`, nor `generic_type` (e.g. a `qualified_type` or a future tree-sitter-go node kind). The fallback returns `node.text`, which for a qualified or generic-spanning receiver includes extra tokens (package qualifier, brackets, type args).
- **Expected:** enclosingClass for a method should be the bare receiver type name (`Foo`), consistent with the documented `*Foo`/`Foo` → `Foo` normalization in walk.ts:9-11.
- **Actual:** On an unrecognized node the raw text (potentially `pkg.Foo` or `Foo[T]` with whitespace) becomes enclosingClass, which then flows into the method's qualifiedName `(<receiver>).<name>`.
- **Why it matters:** A malformed enclosingClass produces inconsistent qualifiedNames and (in the Rust analogue where enclosingClass is used as a method-narrowing key) could break narrowing. In Go enclosingClass is not used for edge narrowing, so impact is limited to identity/display. Flagged as fragile because the `/* v8 ignore */` shows it is untested and relies on the grammar never producing other receiver node kinds.
- **Recommendation:** Return null (unknown receiver) instead of raw text on the unrecognized branch, or explicitly handle `qualified_type` by taking its trailing identifier — matching the conservative null-on-unknown stance used elsewhere.
- **Proving test:** Construct/parse a method whose receiver decodes to a non-handled node kind and assert enclosingClass is a bare identifier (or null), never multi-token text.

#### 98. Rust `super` from the crate root resolves to a fabricated `crate::X` instead of being treated as external/unresolvable

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `graph-adapter-langs` · **Audit confidence:** medium
- **Files:** `packages/graph/graph-rust/src/resolve-dependencies.ts:258`
- **Code:**
  ```ts
      const remaining = current.slice(0, Math.max(1, current.length - supers));
      return [...remaining, ...segments.slice(supers)];
  ```
- **Concern:** Off-by-one clamp masks an invalid path
- **Trigger:** A `use super::X;` (or `super::super::...`) whose importer module path is `crate` (i.e. src/lib.rs or src/main.rs), or where `supers` exceeds the module depth. `Math.max(1, len - supers)` clamps to keep `crate`, so `super::foo` from the crate root yields `['crate','foo']`.
- **Expected:** `super` from the crate root is not valid Rust; such a path cannot resolve to an in-crate module and should return [] (external/unresolvable), not a synthesized `crate::foo`.
- **Actual:** The clamp silently absorbs the over-walk and produces `crate::<remainder>`, which can then spuriously match an unrelated `crate::foo` module-init and emit a wrong dependency edge.
- **Why it matters:** On valid code this branch can only fire if `supers >= current.length`, which valid Rust forbids — so impact on real code is minimal. But the clamp converts an impossible path into a confident wrong target rather than an empty result; a partial/recovered AST or unusual layout could surface a misattributed edge.
- **Recommendation:** When `supers >= current.length - 1` (would walk above `crate`), return null so the specifier resolves to [] rather than clamping to crate root.
- **Proving test:** Resolve `use super::foo;` from an importer whose modulePath is `crate`; assert `to: []` (currently resolves to a `crate::foo` module-init if one exists).

#### 99. For a qualified JSX tag `<A.B/>` the leftmost identifier `A` is wrongly admitted as a value-reference candidate; the in-code comment claiming it is 'excluded by isStructuralParent' is factually wrong

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `graph-adapter-ts` · **Audit confidence:** high
- **Files:** `packages/graph/graph-typescript/src/walk.ts:504-505`, `packages/graph/graph-typescript/src/walk.ts:516-525`, `packages/graph/graph-typescript/src/edges-value-reference.ts:38-72`
- **Code:**
  ```ts
  // A qualified tag (`<A.B/>`) is a
  // PropertyAccess/QualifiedName and is already excluded by `isStructuralParent`.
  ...
  function isStructuralParent(parent: ts.Node): boolean {
    return (
      ts.isQualifiedName(parent) ||
      ts.isImportSpecifier(parent) || ... ts.isTypeReferenceNode(parent));
  }
  ```
- **Concern:** missed/false call-form classification; comment asserts an invariant the code does not enforce
- **Trigger:** A JSX element with a qualified tag, e.g. `<A.B prop={1}/>`, where A is a value identifier (verified via AST probe: A's parent is a PropertyAccessExpression with parent.expression===A, NOT a QualifiedName).
- **Expected:** Per the comment, `A` in `<A.B/>` should be excluded from value-reference resolution (only the JSX element node owns the edge).
- **Actual:** isStructuralParent only matches QualifiedName, not PropertyAccessExpression, so isLikelyValueReference(A) returns true and A is pushed as a resolver candidate. The matching resolver predicate isValueReference(A) also returns true (its isStructuralName/isCallSiteTarget likewise don't cover A in this position). Today no spurious edge is emitted ONLY because resolveSymbolToHash declines non-function-shaped declarations (A is typically a namespace import / object). If A ever resolves to a function-shaped declaration, a spurious value-reference edge is emitted at A's column.
- **Why it matters:** The safety relies on an unstated downstream invariant (namespace/object symbols aren't function-shaped), not on the stated exclusion. A future change to resolveSymbolToHash (e.g. resolving class/value namespaces) would silently start fabricating edges, and the misleading comment would steer a maintainer wrong.
- **Recommendation:** Add `ts.isPropertyAccessExpression(parent)` handling so the JSX-qualified-tag leftmost identifier is excluded the way the comment claims (or fix the comment and add an explicit exclusion for `parent.parent` being a JSX*Element whose tagName chain roots at this identifier). Add a regression test for `<A.B/>` asserting no value-reference edge to `A`.
- **Proving test:** Walk a .tsx file containing `import * as A from './a'; export const C = () => <A.B/>;` and assert no CallSiteRecord/edge is created for identifier `A` (only the JsxSelfClosingElement is a candidate). Then make A a local function and assert still no spurious edge.

#### 100. Default-import re-export `import Foo from './x'; export { Foo };` is silently dropped — buildImportSourceMap only reads NamedImports, never the default binding

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `graph-adapter-ts` · **Audit confidence:** high
- **Files:** `packages/graph/graph-typescript/src/walk.ts:245-259`, `packages/graph/graph-typescript/src/walk.ts:296-306`
- **Code:**
  ```ts
  const named = stmt.importClause?.namedBindings;
  if (!named || !ts.isNamedImports(named)) continue;
  for (const el of named.elements) {
    imported.set(el.name.text, { specifier: ..., importedName: (el.propertyName ?? el.name).text });
  }
  ```
- **Concern:** missed re-export form -> lost cross-package reachability edges (false negatives)
- **Trigger:** A barrel that re-exports a default import without `from`: `import Foo from './x';\nexport { Foo };` (also `import Foo from './x'; export { Foo as Bar };`).
- **Expected:** Per the ReExportRecord doc (walk.ts:111-121: 'bindings IMPORTED at the top of the file'), this should yield a ReExportRecord with sourceName 'default', specifier './x'.
- **Actual:** A default import is `clause.name` (verified: namedBindings is none), but buildImportSourceMap only iterates `NamedImports.elements`, so `Foo` is never in the `imported` map. pushReExportsFromStmt Form 2 then finds no entry for Foo and skips it (treats it as a local definition). The re-export chain through the barrel is lost, so the export index can't follow it and downstream cross-package call/reachability edges to the re-exported default are dropped.
- **Why it matters:** Default-export-then-re-export through index barrels is a very common pattern; missing it produces under-connected graphs (false orphans / missed callers), which directly affects the orphan-subtree and reachability rules the graph tool gates on.
- **Recommendation:** In buildImportSourceMap, also record the default binding: if `stmt.importClause?.name` is set, `imported.set(clause.name.text, { specifier, importedName: 'default' })`. Mirror in the namespace-import case if namespace re-exports are later supported.
- **Proving test:** In walk-reexports.test.ts add: reExportsOf("import Foo from './x';\nexport { Foo };") should equal [{fromFile:'index.ts',exportedName:'Foo',sourceName:'default',specifier:'./x'}]. Currently returns [].

#### 101. isReturnValueDiscarded misses void/comma/as/non-null discard wrappers — only parenthesized and await are unwrapped

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `graph-adapter-ts` · **Audit confidence:** high
- **Files:** `packages/graph/graph-typescript/src/edges.ts:490-500`
- **Code:**
  ```ts
  export function isReturnValueDiscarded(node: ts.Node): boolean {
    let parent: ts.Node | undefined = node.parent;
    while (parent) {
      if (ts.isParenthesizedExpression(parent) || ts.isAwaitExpression(parent)) { parent = parent.parent; continue; }
      return ts.isExpressionStatement(parent);
    }
    return false;
  }
  ```
- **Concern:** heuristic correctness — discarded flag mislabeled for some discard forms
- **Trigger:** `void foo();`, `foo() as T;`, `foo()!;`, and `(bar(), foo());` as statements.
- **Expected:** The call's return value IS discarded in all of these (it is a top-level expression statement with the value thrown away).
- **Actual:** `void foo()` -> parent is VoidExpression -> returns isExpressionStatement(VoidExpression)=false; same for AsExpression (`as`), NonNullExpression (`!`), and the left operand of a comma. So discarded is reported false for these genuinely-discarded calls.
- **Why it matters:** The `discarded` flag feeds rules (e.g. side-effect/return-value heuristics). Mislabeling is low-impact and these forms are uncommon, but the unwrap list is an unstated invariant: adding a new wrapper to the language (or a refactor that introduces these forms) silently degrades the flag. The boundary extractor reuses this same function, so any divergence is consistent at least.
- **Recommendation:** Extend the transparent-wrapper set to include VoidExpression, AsExpression, NonNullExpression (and TypeAssertionExpression), and consider treating the non-final operand of a comma BinaryExpression as discarded. Add unit cases to the existing isReturnValueDiscarded tests.
- **Proving test:** Unit: isReturnValueDiscarded(callExpr) for sources `void foo();`, `foo() as T;`, `foo()!;` should be true; currently all return false.

#### 102. --gate-compare with a missing baseline skips the --sarif write (no file for the if:always() upload on a first run)

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `graph-cli` · **Audit confidence:** medium
- **Files:** `packages/graph/engine/src/cli/graph-modes.ts:99`, `packages/graph/engine/src/cli/graph.ts:260-263`, `packages/graph/engine/src/cli/graph/graph-command-spec.ts:268-299`
- **Code:**
  ```ts
  const result = await cli.compareBaseline('graph', envelope);
  ```
- **Concern:** swallowed/diverted error path defeats the documented 'SARIF lands even when the gate fails' invariant for one case
- **Trigger:** `opensip graph --gate-compare --sarif graph.sarif` when no baseline has been saved yet. compareBaseline throws ConfigurationError (documented exit 2). That propagates out of runGateMode → deliverGraphResult → executeGraph's catch (handleGraphError), which returns `undefined`. The subsequent `--sarif` write is then skipped because `envelope === undefined`.
- **Expected:** The CLAUDE.md/spec intent is that the --sarif file is written under if:always() semantics so Code Scanning still receives findings even when the gate step fails. A missing-baseline configuration error is arguably distinct from a 'gate fail', but a contributor wiring gate-compare+sarif before the first --gate-save gets no SARIF artifact and no obvious cause.
- **Actual:** On the missing-baseline path the SARIF file is never written; the CI upload step has nothing to upload.
- **Why it matters:** Marginal: only the first-run/no-baseline case is affected, and the documented remedy is 'run --gate-save first'. Flagged because the code's own comments claim the SARIF 'lands even when the gate fails', and this is a path where it does not.
- **Recommendation:** Consider writing the run's SARIF before invoking the gate diff (so the artifact lands regardless of baseline state), or document that --gate-compare requires an existing baseline for --sarif to be produced.
- **Proving test:** Run `graph --gate-compare --sarif /tmp/g.sarif` with an empty datastore (no baseline) and assert whether /tmp/g.sarif is created (today it is not).

#### 103. `importedPackagesByFile` resolves dependency targets via last-writer-wins `byBodyHash`, mis-attributing imports if module-init bodyHashes ever collide across packages

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `graph-pipeline` · **Audit confidence:** medium
- **Files:** `packages/graph/engine/src/pipeline/indexes.ts:97-109`
- **Code:**
  ```ts
  for (const dep of occ.dependencies ?? []) {
    for (const targetHash of dep.to) {
      const target = byBodyHash.get(targetHash); // single winner, not occurrencesByHash
      if (target) set.add(pkgOf(target));
    }
  }
  ```
- **Concern:** resolution correctness relying on an unstated cross-package invariant (module-init body uniqueness)
- **Trigger:** A future/third-party graph adapter whose module-init bodyHash does NOT prefix the file path (so two files with byte-identical top-level statements collide). The current TS and tree-sitter-common adapters DO prefix `filePathProjectRel`, so the collision cannot occur today.
- **Expected:** A file's imported-package set should reflect the actual imported target's package.
- **Actual:** `byBodyHash.get(targetHash)` returns only the last occurrence written for that hash. If a module-init target hash is shared across packages, the import is credited to the wrong package, which then mis-constrains `resolveCallee` (include/exclude the wrong candidate) and the coupling/SCC graphs.
- **Why it matters:** resolveCallee uses importedPackagesByFile to disambiguate body-hash collisions; a wrong import set silently routes a duplicated-body callee to the wrong package. It works only because every shipped adapter happens to make module-init hashes file-unique — an invariant not enforced by the engine.
- **Recommendation:** Resolve dependency targets via `occurrencesByHash` and union all packages of all occurrences sharing the hash (mirroring the twin-aware adjacency in buildAdjacency), instead of the single `byBodyHash` winner; or assert/document that module-init hashes must be file-unique.
- **Proving test:** Construct a catalog where two module-inits in different packages share a bodyHash and a third file's dependency `to` references that hash; assert importedPackagesByFile credits BOTH packages, not just the last-written one.

#### 104. Production/test reachability seeds are chosen from last-writer-wins `byBodyHash`, so a prod function with a byte-identical test twin can be mis-seeded

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `graph-pipeline` · **Audit confidence:** hypothesis
- **Files:** `packages/graph/engine/src/pipeline/features.ts:229-256`, `packages/graph/engine/src/rules/_entry-points.ts:42-45`
- **Code:**
  ```ts
  // computeProdReachable
  for (const ep of inferEntryPoints(catalog, indexes)) {
    const occ = indexes.byBodyHash.get(ep.bodyHash);
    if (occ.inTestFile) continue;   // winner decides test-vs-prod
    seeds.add(ep.bodyHash);
  }
  // computeTestReachable
  for (const [hash, occ] of indexes.byBodyHash) { if (occ.inTestFile) seeds.add(hash); }
  ```
- **Concern:** reachability correctness when prod and test occurrences share a content bodyHash (body-twins)
- **Trigger:** A production function and a test-file function with byte-identical normalized bodies (so they share a bodyHash). The `byBodyHash` winner (last writer) is the test occurrence.
- **Expected:** `computeProdReachable` seeds from the prod occurrence; `computeTestReachable` seeds the test occurrence — independent of which twin won the content-dedup slot.
- **Actual:** Both passes read the single `byBodyHash` winner's `inTestFile`. If the winner is the test twin, the prod entry is skipped from prod-reachable seeds (and conversely a prod-winner hides a test entry from test-reachable seeds). This can flip `reachableOnlyFromTests`/`testReachable`, which gate `graph:test-only-reachable` and `graph:high-blast-untested`.
- **Why it matters:** These flags drive production-only gates; a misclassification could surface a false high-blast-untested finding or suppress a real one. The adjacency is twin-aware (ADR-0003), but the SEED selection here is not, creating an inconsistency.
- **Recommendation:** Select prod/test seeds from `occurrencesByHash` (any/all occurrences) rather than the single `byBodyHash` winner — e.g. seed prod-reachable when ANY occurrence of the hash is non-test, seed test-reachable when ANY occurrence is a test file.
- **Proving test:** Catalog with prod fn P and test fn T sharing bodyHash H (T last-written so it wins byBodyHash); both have callers/callees. Assert P is in computeProdReachable's result and H is in computeTestReachable's seeds; with the current code one of these fails depending on winner.

#### 105. Built-in dead-code recipe's explicit rule ids are silently dropped if a rule slug is renamed (resolveExplicitArm ignores unknown ids)

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `graph-render-persist` · **Audit confidence:** high
- **Files:** `packages/graph/engine/src/recipes/built-in-recipes.ts:28-34`, `packages/graph/engine/src/recipes/resolve.ts:77-97`
- **Code:**
  ```ts
  rules: { type: 'explicit', ids: ['graph:orphan-subtree', 'graph:test-only-reachable'] },
  ```
- **Concern:** invalid state / silent selection drift
- **Trigger:** Rename or remove a rule slug in rules/registry.ts (e.g. `graph:orphan-subtree`) without updating built-in-recipes.ts. `resolveExplicitArm` builds a by-id map and only pushes ids it finds, silently skipping unknown ids.
- **Expected:** A built-in recipe referencing a nonexistent rule should fail loudly (the parallel rule-id-mapping table throws on an unknown slug for exactly this class of drift).
- **Actual:** `resolveSelector`'s explicit arm drops unknown ids with no error, so `dead-code` would resolve to fewer (or zero) rules and the run would quietly do less work, reporting success.
- **Why it matters:** Silent under-selection of gate rules is a correctness hazard for a gating tool — a recipe could stop enforcing its intended rules with no signal. (The existing resolve.test.ts pins the current two slugs, which would catch a rename, so the live risk is low.)
- **Recommendation:** Validate at recipe construction (or in a startup assertion) that every explicit id in a built-in recipe exists in BUILT_IN_RULES, throwing on mismatch — symmetric with the unknown-slug throw in rule-id-mapping.ts.
- **Proving test:** Temporarily rename `orphanSubtreeRule.slug` and assert that resolving the `dead-code` recipe throws rather than silently returning a 1-element rule list.

#### 106. resolve.ts docstring claims 'registration order is preserved' but the explicit arm returns rules in recipe request order

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** improvement · **Subsystem:** `graph-render-persist` · **Audit confidence:** high
- **Files:** `packages/graph/engine/src/recipes/resolve.ts:8-12`, `packages/core/src/recipes/selector.ts:128-146`
- **Code:**
  ```ts
  * `explicit`/`all` arms match. Registration order is preserved.
  ```
- **Concern:** documentation vs behavior contract mismatch
- **Trigger:** Define an explicit recipe whose `ids` are listed in a different order than registry order; the resolved `Rule[]` follows the `ids` order, not registry order.
- **Expected:** Behavior matches the stated invariant, or the invariant is corrected. Today graph rule evaluation is order-independent, so output is unaffected — only the documented contract is wrong.
- **Actual:** `resolveExplicitArm` iterates `ids` (request order) and pushes matches; the `all` arm preserves item (registry) order. So the 'registration order is preserved' claim only holds for the `all` arm.
- **Why it matters:** A future consumer that relies on the documented 'registration order' for explicit recipes (e.g. deterministic display ordering) would be wrong; harmless today only because evaluation is order-insensitive.
- **Recommendation:** Tighten the docstring to 'the all arm preserves registration order; the explicit arm preserves recipe request order', or sort explicit results to registry order if that is the intended contract.
- **Proving test:** Resolve an explicit recipe with `ids` reversed relative to registration and assert the documented ordering; today the result is request order.

#### 107. GraphConfig threshold defaults documented in types.ts contradict the actual in-rule defaults

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** improvement · **Subsystem:** `graph-rules` · **Audit confidence:** high
- **Files:** `packages/graph/engine/src/rules/large-function.ts:28-29`, `packages/graph/engine/src/rules/wide-function.ts:25-26`, `packages/graph/engine/src/rules/high-blast-untested.ts:31-32`
- **Code:**
  ```ts
  // large-function.ts
  const DEFAULT_WARN_LINES = 300; const DEFAULT_ERROR_LINES = 500;
  // wide-function.ts
  const DEFAULT_WARN_PARAMS = 5; const DEFAULT_ERROR_PARAMS = 7;
  // high-blast-untested.ts
  const DEFAULT_WARN_BLAST = 75; const DEFAULT_ERROR_BLAST = 150;
  ```
- **Concern:** API contract / documentation mismatch that misleads threshold tuning
- **Trigger:** A user reads the JSDoc on GraphConfig fields in types.ts to decide override values. types.ts says largeFunctionWarnLines 'In-rule default: 80', largeFunctionErrorLines 'default: 150', wideFunctionWarnParams 'In-rule default: 4', highBlastWarnThreshold 'default: 8', highBlastErrorThreshold 'default: 20'.
- **Expected:** Documented defaults match the constants the rules actually use.
- **Actual:** The rules use warn/error of 300/500 (large), 5/7 (wide), 75/150 (high-blast) — wildly different from the documented 80/150, 4, 8/20. A user assuming highBlastWarnThreshold defaults to 8 (extremely noisy) when it is really 75 will badly mis-tune, and a contributor reading the contract gets the wrong mental model of gate strictness.
- **Why it matters:** The config contract these rules consume is wrong by an order of magnitude in places (8 vs 75). Even though each rule file is internally consistent, the authoritative GraphConfig docstrings users read are stale, causing wrong override choices and surprising gate behavior.
- **Recommendation:** Update the JSDoc on largeFunctionWarnLines/ErrorLines, wideFunctionWarnParams, highBlastWarnThreshold/ErrorThreshold in packages/graph/engine/src/types.ts to the real constants (300/500, 5/7, 75/150), or centralize defaults in one place the docs can reference, so the contract cannot drift from the rule constants.
- **Proving test:** Add a guard test that asserts the documented default in types.ts comments equals the DEFAULT_* constant in each rule (or read defaults from a shared const) so the two cannot diverge.

#### 108. unexpected-coupling encodes package-pair keys with a space delimiter, brittle to package names containing spaces

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `graph-rules` · **Audit confidence:** hypothesis
- **Files:** `packages/graph/engine/src/rules/unexpected-coupling.ts:85`, `packages/graph/engine/src/rules/unexpected-coupling.ts:90`
- **Code:**
  ```ts
  directed.add(`${e.callerPackage} ${e.calleePackage}`);
  ...
  const [from, to] = key.split(' ') as [string, string];
  ```
- **Concern:** ser/deser of composite key; fragile invariant
- **Trigger:** A package label containing a space. pkgOf returns the package.json `name` (npm names cannot contain spaces) OR the path-segment / '<unknown>' fallback (assign-packages.ts) — none currently contain spaces, but a future adapter or non-npm layout that yields a label with a space would silently mis-split.
- **Expected:** Composite key round-trips losslessly for any package label.
- **Actual:** `${a} ${b}` then key.split(' ') with destructuring [from,to] silently drops/mis-assigns the package name if either side contains a space, producing wrong reverse-edge lookups (missed or phantom cycles).
- **Why it matters:** Relies on the unstated invariant 'package labels never contain a space.' It holds for npm names today, so this is not currently triggerable, but the encoding is a latent correctness hazard if the package-label source changes.
- **Recommendation:** Key the directed-edge set on a tuple/Map keyed by both fields, or use a delimiter that cannot appear in a label (e.g. a NUL ' '), and reverse-lookup with the structured key rather than split(' ').
- **Proving test:** Feed PackageEdgeFeature rows with callerPackage='my pkg', calleePackage='other' plus the reverse, and assert findPackageCycles returns the correct single pair; today the split mangles 'my pkg'.

#### 109. Rust strip mis-classifies r"..." / b"..." as raw/byte strings without an identifier-boundary guard (false-positive stripping)

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `lang-adapters` · **Audit confidence:** high
- **Files:** `packages/languages/lang-rust/src/strip.ts:60-63`, `packages/languages/lang-rust/src/strip.ts:102`
- **Code:**
  ```ts
  if (
    (c === 'r' && (next === '"' || next === '#')) ||
    (c === 'b' && src[i + 1] === 'r' && (src[i + 2] === '"' || src[i + 2] === '#'))
  ) {
  ...
  if (c === 'b' && next === '"') {
  ```
- **Concern:** string/comment detection false positive (missing identifier-boundary anchor)
- **Trigger:** A position where `r` or `b`/`br` immediately follows identifier characters and is immediately followed by a quote/hash, e.g. the token sequence `myr"..."` or `foob"..."`. The scanner reaches the `r`/`b` after consuming the preceding identifier chars one-by-one and treats it as a raw/byte-string prefix.
- **Expected:** Consistent with the sibling lang-python (matchStringStart guards `if (i>0 && isIdentChar(src[i-1])) return null`) and lang-cpp (matchStringPrefix/matchCharLiteralPrefix guard with `isIdentChar(src[i-1])`), a prefix in the middle/end of an identifier should NOT be recognized as a string opener.
- **Actual:** Proven: stripStrings('let x = myr"notraw";') returns 'let x = myr"      ";' — the body of `myr"notraw"` is blanked as if `r"notraw"` were a raw string, even though `r` is part of identifier `myr`.
- **Why it matters:** Byte length is preserved so positions are stable, but the stripped output mis-blanks bytes that are not string content (and conversely could leak a quote into code), feeding wrong input to regex-based universal checks that consume Rust stripStrings/stripComments. Practical impact is low because `identifier"string"` is not valid Rust, but the pack is inconsistent with the documented identifier-boundary discipline used by python/cpp and could misfire on malformed or macro-token input.
- **Recommendation:** Add the same guard the other packs use: before treating `r`/`b`/`br` as a string prefix, reject when `i > 0 && isIdentChar(src[i-1])` (isIdentChar is already exported from @opensip-cli/core and used by lang-cpp). Apply to both the raw/byte-raw branch (line 60) and the byte-string branch (line 102).
- **Proving test:** expect(stripStrings('let x = myr"notraw";')).toBe('let x = myr"notraw";'); expect(stripStrings('let s = r"raw";')).toBe('let s = r"   ";'); // genuine raw string still stripped

#### 110. SARIF artifactLocation.uri can be emitted as an empty string when a signal has no file path

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `output` · **Audit confidence:** medium
- **Files:** `packages/output/src/format/signal-sarif.ts:137`, `packages/output/src/format/signal-sarif.ts:146-147`
- **Code:**
  ```ts
  const filePath = signal.code?.file ?? signal.filePath;
  ...
  const physicalLocation = { artifactLocation: { uri: filePath }, ... };
  ```
- **Concern:** SARIF 2.1.0 conformance / location attribution
- **Trigger:** A signal with both code.file undefined/empty and filePath === '' (createSignal defaults filePath to '' when no code.file is given; the synthetic resolved signal in baseline-diff also yields filePath '' for non-default-form fingerprints).
- **Expected:** A finding without a concrete file should either omit physicalLocation or attach a meaningful URI; an empty-string uri is not a useful location.
- **Actual:** Emits `artifactLocation: { uri: '' }`. Code Scanning may reject the result or attribute it to the repo root; the finding effectively loses its location.
- **Why it matters:** Mislocated or rejected results in the uploaded SARIF degrade the dogfood ratchet's signal quality. Low severity because in practice production producers attach a real file path, but the boundary doesn't guard it.
- **Recommendation:** When filePath is falsy, omit the locations array (a result with no physicalLocation is valid SARIF) rather than emitting an empty uri.
- **Proving test:** buildOpenSipSarif([{...sig, code: undefined, filePath: ''}], driver) — assert the result has no locations (or a non-empty uri), not `uri: ''`.

#### 111. recovery_rate metric is degenerate (always 0 or 1) because errorsGenerated is incremented on every failure, equal to failedRequests

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `simulation` · **Audit confidence:** high
- **Files:** `packages/simulation/engine/src/framework/resolve-metric.ts:99-102`, `packages/simulation/engine/src/framework/execution/run-load-window.ts:100-109`
- **Code:**
  ```ts
  // resolve-metric.ts
  case 'recovery_rate': {
    return metrics.errorsGenerated > 0 ? 1 - metrics.failedRequests / metrics.errorsGenerated : 1;
  }
  // run-load-window.ts dispatchRequest catch:
  } catch {
    metrics.failedRequests++;
    metrics.errorsGenerated++;
  }
  ```
- **Concern:** Metric definition mismatch / misleading assertion semantics
- **Trigger:** Author a chaos/load assertion on `recovery_rate` (e.g. ASSERTIONS.custom('recovery_rate','gte',0.9,...)). The driver increments errorsGenerated in lockstep with failedRequests, so errorsGenerated === failedRequests for every window.
- **Expected:** recovery_rate = 1 - failedRequests/errorsGenerated is meant to express how many *injected* errors the system recovered from, so it should be a meaningful fraction between 0 and 1.
- **Actual:** Since errorsGenerated always equals failedRequests, recovery_rate is exactly 0 whenever there is ≥1 failure and 1 when there are none — it carries no recovery information and can never take an intermediate value.
- **Why it matters:** Any scenario asserting on recovery_rate gets a binary, effectively meaningless verdict; the metric documented as a recovery measure cannot distinguish partial recovery. This is a correctness trap for authors using the documented metric key.
- **Recommendation:** Either populate errorsGenerated only for *injected* faults (distinct from organic target failures) so recovery_rate becomes meaningful, or remove/deprecate the recovery_rate key and document its limitation. The chaos kind already drains fault events (faultModel.drained()) — that count is the natural denominator.
- **Proving test:** Run a chaos scenario with some injected faults that the recovery window clears; assert recovery_rate takes a value strictly between 0 and 1. Currently it can only be 0 or 1.

#### 112. mergeMetrics aggregates percentiles with Math.max, producing statistically invalid p50/p95/p99 for merged windows

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** improvement · **Subsystem:** `simulation` · **Audit confidence:** high
- **Files:** `packages/simulation/engine/src/framework/result-builder.ts:247-249`, `packages/simulation/engine/src/framework/result-builder.ts:228-261`
- **Code:**
  ```ts
  const p50 = Math.max(...metricsList.map((m) => m.p50LatencyMs));
  const p95 = Math.max(...metricsList.map((m) => m.p95LatencyMs));
  const p99 = Math.max(...metricsList.map((m) => m.p99LatencyMs));
  ```
- **Concern:** Numeric precision / incorrect aggregation
- **Trigger:** Any caller of the exported mergeMetrics() that aggregates >1 metrics objects (public API surface, e.g. a host combining multiple windows). max(p95_a, p95_b) is not the p95 of the combined sample set.
- **Expected:** Merged percentiles should reflect the percentile over the union of underlying samples (or at least a defensible approximation), not the max of per-window percentiles which over-states latency.
- **Actual:** Returns the maximum per-window percentile — an upper bound, not the merged percentile. avgLatency is correctly request-weighted, but the percentile fields are not, so the merged object is internally inconsistent (avg may be far below the reported p50).
- **Why it matters:** mergeMetrics is part of the engine's public API (re-exported from index.ts). A consumer relying on it for combined reporting gets misleading latency percentiles. Not used by the internal load/chaos path today (LatencyTracker computes real percentiles), so impact is limited to external consumers.
- **Recommendation:** Either retain the raw sample arrays to compute true merged percentiles (e.g. via LatencyTracker), or clearly document mergeMetrics' percentile fields as an upper-bound approximation and rename them, or drop the function if it has no real consumer.
- **Proving test:** mergeMetrics([{...p50:10}, {...p50:100 with many samples}]) and assert the merged p50 is between 10 and 100 weighted by sample counts, not simply 100.

#### 113. SessionRepo.latest()/list() ordering is nondeterministic for equal millisecond timestamps (no tie-break key)

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `targeting-contracts-session` · **Audit confidence:** high
- **Files:** `packages/session-store/src/session-repo.ts:85-91`, `packages/session-store/src/session-repo.ts:119-122`, `packages/session-store/src/schema/sessions.ts:21`
- **Code:**
  ```ts
  const ordered = baseQuery.orderBy(desc(sessions.timestamp));
  ...
  latest(opts) { const rows = this.list({ ...opts, limit: 1 }); return rows[0] ?? null; }
  ```
- **Concern:** stale-data / wrong-row selection due to unstable sort over a low-resolution (ms) key
- **Trigger:** Two sessions for the same tool persisted within the same millisecond (timestamps come from `new Date().toISOString()` / `envelope.createdAt`, ms resolution). E.g. a script runs `opensip fit` twice in quick succession, or two tools write near-simultaneously. SQLite ORDER BY on equal keys yields rowid/scan order, which is not guaranteed.
- **Expected:** `latest({tool})` (used by `--show latest` replay and `resolveSession({ref:'latest'})`) deterministically returns the most-recently-saved session.
- **Actual:** When timestamps tie at the ms, SQLite may return either row first; `latest()` (LIMIT 1) and the newest-first listing can pick the wrong one. Session ids are UUIDs (no monotonic component), so id ordering cannot break the tie meaningfully either.
- **Why it matters:** `--show latest` could replay the wrong run, and `sessions list` ordering for same-ms rows is arbitrary across runs/engines. Low real-world frequency, but a genuine determinism gap in a feature whose whole job is 'the latest run'.
- **Recommendation:** Add a stable secondary sort key — e.g. a monotonic INTEGER rowid/autoincrement insertion-order column (or a high-resolution timestamp) — and order by `(timestamp DESC, rowid DESC)`. Then `latest` is deterministic regardless of ms collisions.
- **Proving test:** Save two `fit` sessions with identical `timestamp:'2026-06-12T00:00:00.000Z'` (ids 'A' then 'B'); assert `repo.latest({tool:'fit'})?.id` is stably the last-inserted ('B') across repeated runs. Today this is not guaranteed.

#### 114. A single corrupt/unknown-tool session row makes the entire `sessions list` command throw, hiding all valid sessions

- **Status:** 🔴 LIVE · **Severity:** low · **Kind:** risk · **Subsystem:** `targeting-contracts-session` · **Audit confidence:** high
- **Files:** `packages/session-store/src/session-repo.ts:92-95`, `packages/session-store/src/session-repo.ts:186-196`
- **Code:**
  ```ts
  for (const row of sessionRows) {
    results.push(this.hydrateSession(row));
  }
  ...
  if (!isToolShortId(row.tool)) {
    throw new SystemError(`Session ${row.id} has unknown tool value: ...`, { code: 'SYSTEM.DATA.UNKNOWN_TOOL' });
  }
  ```
- **Concern:** swallowed/over-broad error handling: one bad row aborts a bulk read
- **Trigger:** A row with a `tool` value outside `['fit','sim','graph']` exists (hand-edited DB, a schema-drift/legacy row, or — per the ids.ts note — any future attempt to store a third-party tool session). The guard in `hydrateSession` throws, and `list()` rethrows on the first such row encountered.
- **Expected:** `sessions list` surfaces the corrupt row as a warning/skip and still lists the valid sessions; one poisoned row should not deny access to all history.
- **Actual:** `list()` throws on the first corrupt row, so the whole command fails and no sessions are shown. The unit test (session-repo.test.ts:274-283) confirms this is the intended behavior, but it is a fragile fail-closed: corruption of one row is a total-listing outage.
- **Why it matters:** Hand-edited or legacy databases (and any future third-party-tool persistence the ids.ts comment anticipates) turn a single bad value into a complete loss of `sessions list` / `--show latest` functionality, with no way to view the good rows.
- **Recommendation:** In `list()`, catch per-row hydration errors, emit a structured warning (the diagnostics bus / logger.warn), and skip the bad row instead of aborting the whole listing. Keep the strict throw for single-row `get()`/`resolveSession` where the caller asked for that specific id.
- **Proving test:** Save 3 valid sessions, poison one row's `tool` to 'not-a-real-tool' via a direct update, then `repo.list()` should return the 3 (or 2 valid) and log a warning — not throw and return nothing.

## 🟢 Already fixed by your parallel work (verified)

### HIGH

#### 1. scheduleUnits parallel mode hangs forever when shouldAbort fires with units still unlaunched

- **Status:** 🟢 FIXED (verified in working tree) · **Severity:** high · **Kind:** bug · **Subsystem:** `core-lib` · **Audit confidence:** high
- **Files:** `packages/core/src/lib/execution/schedule.ts:86-117`, `packages/core/src/lib/execution/schedule.ts:95`, `packages/core/src/lib/execution/schedule.ts:103`
- **Code:**
  ```ts
  if (!stopping && nextIndex < units.length && shouldAbort?.() !== true) {
    /* relaunch */
  }
  if (activeCount === 0 && (nextIndex >= units.length || stopping)) {
    resolve();
  }
  ```
- **Concern:** concurrency / resource lifecycle — promise never resolves (deadlock)
- **Trigger:** Parallel mode (mode:'parallel') where maxParallel < units.length, and the external shouldAbort() flips to true while units remain unlaunched, and no in-flight unit returns shouldStop:true. e.g. FitnessRecipeService.abort() / SimulationRecipeService abortSignal called mid-run.
- **Expected:** When the run is aborted, in-flight units drain and the scheduler resolves (the run completes/cancels), matching the sequential path which break-returns on abort.
- **Actual:** The relaunch guard stops launching new units (correct), but the resolve condition is `activeCount===0 && (nextIndex >= units.length || stopping)`. After abort, nextIndex is still < units.length and `stopping` is false, so once all in-flight units drain (activeCount===0) the resolve condition is `0===0 && (false || false)` = false. resolve() is never called and the returned Promise hangs forever. There is no outer timeout (executeRecipeInScope awaits scheduleUnits directly), so the entire recipe run deadlocks.
- **Why it matters:** FitnessRecipeService.abort() (packages/fitness/engine/src/recipes/service.ts:462) and the simulation service's abortSignal (packages/simulation/engine/src/recipes/service.ts:270) are public cancel paths wired straight into scheduleUnits' shouldAbort in parallel mode. A SaaS host cancel, a Ctrl-C handler, or a watchdog that aborts a parallel fit/sim run will silently hang the process instead of cancelling it — a stuck run with no error, blocking the event loop.
- **Recommendation:** Include the abort condition in the resolve predicate. Either set a `stopping = true` (or a separate `aborted` flag) when shouldAbort() is observed in the finally handler, or change the resolve condition to `activeCount === 0 && (nextIndex >= units.length || stopping || shouldAbort?.() === true)`. The sequential branch already handles abort correctly by breaking; the parallel branch must resolve when drained-and-aborted.
- **Proving test:** await scheduleUnits<number>({ units:[1,2,3,4,5,6], mode:'parallel', maxParallel:2, shouldAbort:()=>aborted, runUnit: async (u)=>{ if(u===1) aborted=true; return {shouldStop:false}; } }) — wrap in a 1s test timeout; today it never resolves. Assert it resolves and that units beyond the in-flight window did not launch. (The existing parallel abort test only flips `aborted` on the LAST unit, after nextIndex already reached units.length, so it never exercises this path.)
- **Re-check vs current working tree:** _fixed_ — The defect was that the parallel-mode resolve predicate at schedule.ts:103 was `activeCount === 0 && (nextIndex >= units.length || stopping)`, which never became true after an external abort left units unlaunched (nextIndex < units.length and stopping false), so the returned Promise hung forever once in-flight units drained.

The current working tree implements exactly the recommended fix. packages/core/src/lib/execution/schedule.ts:79-86 introduces a latched `aborted` flag set by `observeAbort()` whenever `shouldAbort?.()` returns true. The relaunch guard at schedule.ts:119 now reads `!stopping && !aborted && nextIndex < units.length && !observeAbort()`, so observing the abort both stops further launches and latches `aborted = true`. Critically, the resolve predicate at schedule.ts:129 is now `activeCount === 0 && (nextIndex >= units.length || stopping || aborted)` — the abort condition is included.

Tracing the defect's exact scenario (units [1..6], parallel, maxParallel:2, runUnit flips external abort on unit 1): the initial batch launches indices 0 and 1 (nextIndex=2). When unit 1's finally runs, `observeAbort()` sees the external abort, latches `aborted=true`, blocks relaunch; activeCount is still 1 so resolve is skipped. When unit 2's finally runs, activeCount drops to 0 and the predicate evaluates `0===0 && (2>=6 false || stopping false || aborted TRUE)` = true, so resolve() fires. Units 3-6 are never launched. The drained-and-aborted case now resolves, matching the sequential branch (schedule.ts:90 `if (observeAbort()) break;`). The mechanism described in the defect is fully closed.
  - Current code: `if (activeCount === 0 && (nextIndex >= units.length || stopping || aborted)) {
  resolve();
}`

### LOW

#### 2. Invalid/unparseable StoredSession.timestamp is silently coerced to NaN and rejected late as a NOT NULL violation rather than validated

- **Status:** 🟢 FIXED (verified in working tree) · **Severity:** low · **Kind:** risk · **Subsystem:** `targeting-contracts-session` · **Audit confidence:** high
- **Files:** `packages/session-store/src/session-repo.ts:44`, `packages/session-store/src/session-repo.ts:208`
- **Code:**
  ```ts
  timestamp: new Date(session.timestamp).getTime(),  // save
  ...
  timestamp: new Date(row.timestamp).toISOString(),    // hydrate
  ```
- **Concern:** bad validation / unclear failure mode for malformed input crossing the type boundary
- **Trigger:** A caller (e.g. a third-party tool, or a future code path) passes a StoredSession.timestamp that is not a valid date string. `new Date('not-a-date').getTime()` is NaN.
- **Expected:** A malformed timestamp is rejected with a clear, actionable error at the validation boundary (mirroring the explicit `isToolShortId` guard the same method applies to `row.tool`).
- **Actual:** NaN is handed to drizzle; SQLite stores NaN as NULL in the integer column, tripping `NOT NULL constraint failed: sessions.timestamp` and aborting the transaction. The error names the column, not the bad input — and the symmetric hydrate path would produce `Invalid Date.toISOString()` (a RangeError) if a NaN ever landed in the column. Proven by probe.
- **Why it matters:** First-party callers always pass `new Date().toISOString()`/`envelope.createdAt`, so this is not hit today, but the boundary that explicitly guards `tool` leaves `timestamp` un-validated, so a future/third-party caller gets an opaque storage error instead of a domain error.
- **Recommendation:** Validate `Number.isFinite(new Date(session.timestamp).getTime())` in `save()` and throw a SystemError (e.g. `SYSTEM.DATA.INVALID_TIMESTAMP`) with the offending value, matching the existing `UNKNOWN_TOOL` guard style.
- **Proving test:** `repo.save({...valid, timestamp:'not-a-date'})` should throw a clear validation error naming the bad timestamp, not `NOT NULL constraint failed: sessions.timestamp`.
- **Re-check vs current working tree:** _fixed_ — The defect (invalid/unparseable StoredSession.timestamp silently coerced to NaN and rejected late as a NOT NULL constraint violation) is fully resolved in the current working tree.

At packages/session-store/src/session-repo.ts:43-50, save() now validates the timestamp eagerly BEFORE any DB write: it computes `const ts = new Date(session.timestamp); const tsMs = ts.getTime();` then `if (!Number.isFinite(tsMs)) throw new ValidationError(...)`. The thrown ValidationError carries code 'VALIDATION.SESSION.INVALID_TIMESTAMP' (line 48) and a message that names the offending input via `JSON.stringify(session.timestamp)` plus the session id and tool (line 47). This mirrors the existing `isToolShortId` guard style the recommendation cited.

The subsequent insert at session-repo.ts:57 uses `timestamp: tsMs` (the already-validated finite value) rather than recomputing `new Date(session.timestamp).getTime()` inline, so NaN can never reach the integer column. `new Date('not-a-date').getTime()` is NaN, and `Number.isFinite(NaN)` is false, so the exact trigger described (`timestamp: 'not-a-date'`) now throws a clear ValidationError naming the bad value instead of `NOT NULL constraint failed: sessions.timestamp`.

I confirmed SessionRepo.save() is the only production writer to sessions.timestamp (grep over packages/session-store and packages/datastore found only session-repo.ts:57 as a writer; line 221 is the read/hydrate path). Because no NaN can be written anymore, the symmetric hydrate-path concern at session-repo.ts:221 (`new Date(row.timestamp).toISOString()` producing an Invalid Date RangeError) is also structurally precluded for all rows written through this guarded path.

ValidationError and isToolShortId are both confirmed exported from the @opensip-cli/core barrel (packages/core/src/index.ts:304 and :225), and ValidationError's constructor honors options.code (packages/core/src/lib/errors.ts:53-58), so the custom code propagates correctly.

The recommendation suggested SystemError/SYSTEM.DATA.INVALID_TIMESTAMP; the implementation chose ValidationError/VALIDATION.SESSION.INVALID_TIMESTAMP, which is semantically more apt for input-boundary validation and still satisfies the expected behavior (clear, actionable error at the validation boundary naming the bad input). The exact mechanism is closed.
  - Residual gap: No dedicated unit test asserts the new validation (grep for INVALID_TIMESTAMP / 'not-a-date' in __tests__ found none), but the production code fully resolves the defect mechanism; the missing test is a coverage gap, not a residual live defect.
  - Current code: `const ts = new Date(session.timestamp);
const tsMs = ts.getTime();
if (!Number.isFinite(tsMs)) {
  throw new ValidationError(
    `Invalid session timestamp for session ${session.id} (tool=${session.tool}): ${JSON.stringify(session.timestamp)}`,
    { code: 'VALIDATION.SESSION.INVALID_TIMESTAMP' },
`
