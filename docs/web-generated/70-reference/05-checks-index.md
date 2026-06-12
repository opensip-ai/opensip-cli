---
status: current
last_verified: 2026-06-12
release: v3.0.x
title: "Checks reference"
audience: [getting-started, ci-integrators, plugin-authors]
purpose: "Browsable index of every built-in fit check, grouped by pack and primary tag. Auto-generated from source by scripts/build-checks-index.mjs."
source-files:
  - packages/fitness/checks-universal/src/checks/
  - packages/fitness/checks-typescript/src/checks/
  - packages/fitness/checks-python/src/checks/
  - packages/fitness/checks-go/src/checks/
  - packages/fitness/checks-java/src/checks/
  - packages/fitness/checks-cpp/src/checks/
  - packages/fitness/checks-rust/src/checks/
related-docs:
  - ../00-start/02-show-me-the-loops.md
  - ../50-extend/01-plugin-authoring.md
  - ../50-extend/04-check-pack-architecture.md
---
# Checks reference

opensip-tools ships **166 built-in checks** across seven packs. Each check is a single source file that returns violations when the rule is broken. Below: every check by pack, grouped by primary tag, with the one-line description from `defineCheck`.

> This page is **auto-generated** from the source by [`scripts/build-checks-index.mjs`](https://github.com/opensip-ai/opensip-tools/blob/main/scripts/build-checks-index.mjs). Do not edit it by hand — edit the check's source file (the link in each row), then re-run the generator.

---

## Universal  *(108 checks)*

Language-agnostic; runs against every project.

### Architecture  *(29)*

| Slug | Description |
|---|---|
| [`capability-by-manifest`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/capability-by-manifest.ts) | A capability domain must be declared in a tool manifest and registered via registerCapabilityDomainsFromManifest, not host-compiled (ADR-0023, §5.3) |
| [`command-surface-parity`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/command-surface-parity.ts) | Every tool command resolves to a typed CommandSpec; no raw Commander access from a tool (release 2.11.0 command plane, Principle 6) |
| [`cross-tool-flag-parity`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/cross-tool-flag-parity.ts) | Cross-tool common CLI flags must come from the shared registry, not be hand-declared (ADR-0021) |
| [`docker-ignore-validation`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/docker-ignore-validation.ts) | Validate .dockerignore files exist alongside Dockerfiles with required patterns |
| [`docker-version-sync`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/docker-version-sync.ts) | Validate Docker Node/pnpm versions match package.json |
| [`docs-teach-blessed-seam`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/docs-teach-blessed-seam.ts) | Extension docs must teach the blessed CommandSpec seam, not hand-rolled --json / stdout (§4.8) |
| [`empty-package-detection`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/modules/empty-package-detection.ts) | Detects packages with empty or commented-out exports |
| [`env-var-validation`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/env-var-validation.ts) | Detects environment variable access without proper validation |
| [`graph-signal-stamped`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/graph-signal-stamped.ts) | Graph rules must stamp identity via createGraphSignal, not hand-assemble source/ruleId/severity (§5.9) |
| [`heavy-import-detection`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/heavy-import-detection.ts) | Detects heavy/deprecated library imports and excessive named imports that bloat bundle size |
| [`interface-implementation-consistency`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/modules/interface-implementation-consistency.ts) | Verifies interfaces match their implementations |
| [`live-runs-off-thread`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/live-runs-off-thread.ts) | Live runners drive the engine off the main process; worker entries stay persistence-free (ADR-0028) |
| [`no-bodyhash-keying-outside-identity`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/no-bodyhash-keying-outside-identity.ts) | The graph cross-shard merge must key/stitch edges through ownerEdgeKey in cli/orchestrate/edge-identity.ts, never by a bare bodyHash/ownerHash (ADR-0003) |
| [`no-config-loader-outside-config`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/no-config-loader-outside-config.ts) | A tool-agnostic config block (cli/targets/globalExcludes/checkOverrides/dashboard) must be parsed only in @opensip-tools/config, not hand-rolled elsewhere (ADR-0023) |
| [`no-custom-event-emitter`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/no-custom-event-emitter.ts) | Detects direct EventEmitter usage that should use infrastructure/events |
| [`no-direct-stdout-in-tool-engine`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/no-direct-stdout-in-tool-engine.ts) | Tool engines must emit a SignalEnvelope, not write run output to stdout (ADR-0011) |
| [`no-duplicate-packages`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/dependencies/no-duplicate-packages.ts) | Detects packages that serve the same purpose |
| [`no-module-singleton`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/no-module-singleton.ts) | No module-level mutable registry/loaded-state singleton; per-run state lives on RunScope via a factory (ADR-0023). fileCache/memoryProfiler are exempt. |
| [`node-version-consistency`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/node-version-consistency.ts) | Validate Node.js version consistency across configs |
| [`one-config-document`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/one-config-document.ts) | A tool must validate its config block through a composed Zod schema, not hand-project its own opensip-tools.config.yml namespace (ADR-0023) |
| [`one-outcome-shape`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/one-outcome-shape.ts) | Machine output must be a CommandOutcome via renderOutcome, not a bare {error} / raw JSON (§5.5) |
| [`project-readme-existence`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/project-readme-existence.ts) | Ensures every package has a README.md file |
| [`release-gate-parity`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/release-gate-parity.ts) | Ensure release.yml re-runs every PR-quality gate (lint, test:coverage, fit:ci, graph:ci) before pack/publish (ADR-0017) |
| [`restrict-raw-db-access`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/restrict-raw-db-access.ts) | Confine the raw Drizzle handle (DataStore.db) to the persistence ownership boundary (ADR-0009) |
| [`same-recipe-semantics`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/same-recipe-semantics.ts) | Recipe execution must run on the shared substrate; no per-tool scheduler reimplementation (§5.8/§4.3) |
| [`stale-build-artifacts`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/stale-build-artifacts.ts) | Detects compiled .js/.d.ts/.js.map files in source directories that should only exist in dist/ |
| [`tool-has-manifest`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/tool-has-manifest.ts) | Every first-party tool package must declare a conformant opensipTools manifest (kind/id/apiVersion/commands) the host can read before import (release 3.0.0) |
| [`vitest-config-extends-base`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/vitest-config-extends-base.ts) | Per-package vitest configs must extend the shared .config/vitest.base (when one exists) |
| [`vitest-config-required-with-tests`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/vitest-config-required-with-tests.ts) | Ensures packages with tests have a vitest.config at the package root |

### Security  *(18)*

| Slug | Description |
|---|---|
| [`api-key-rotation`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/security/api-key-rotation.ts) | Validate API key handling supports rotation |
| [`auth-middleware-coverage`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/security/auth-middleware-coverage.ts) | Validate routes have authentication middleware |
| [`auth-route-guard`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/security/auth-route-guard.ts) | Verify (auth) group _layout files include authentication checks (useAuth/useSession hooks) |
| [`cors-configuration`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/security/cors-configuration.ts) | Validate CORS configuration follows security best practices |
| [`csp-headers`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/security/csp-headers.ts) | Validate Content Security Policy headers configuration |
| [`dependency-vulnerability-audit`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/security/dependency-vulnerability-audit.ts) | Dependency vulnerability scanning via package manager audit |
| [`docker-best-practices`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/architecture/docker-best-practices.ts) | Validate Dockerfiles follow security and efficiency best practices |
| [`env-secret-exposure`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/security/env-secret-exposure.ts) | Detect secrets exposed through environment variables in logs or errors |
| [`hasura-production-config`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/security/hasura-production-config.ts) | Verify Hasura production docker-compose has required security settings |
| [`jwt-validation`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/security/jwt-validation.ts) | Validate JWT handling follows security best practices |
| [`no-eval`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/security/no-eval.ts) | Detect dangerous eval and dynamic code execution |
| [`no-hardcoded-secrets`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/security/no-hardcoded-secrets.ts) | Detect hardcoded secrets, API keys, and credentials in source code |
| [`package-supply-chain-policy`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/security/package-supply-chain-policy.ts) | Validate npm/pnpm/Bun supply-chain guardrails |
| [`rate-limit-coverage`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/security/rate-limit-coverage.ts) | Validate routes have rate limiting configured |
| [`semgrep-scan`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/security/semgrep-scan.ts) | Run Semgrep static analysis to detect security vulnerabilities |
| [`sentry-pii-scrubbing`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/sentry/sentry-pii-scrubbing.ts) | Detects missing PII scrubbing in Sentry — personal data may leak to third party |
| [`use-centralized-crypto`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/security/use-centralized-crypto.ts) | Enforce use of centralized crypto module instead of direct crypto operations |
| [`webhook-signature-verification`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/security/webhook-signature-verification.ts) | Detect webhook endpoints without signature verification |

### Quality  *(27)*

| Slug | Description |
|---|---|
| [`async-state-pattern`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/patterns/async-state-pattern.ts) | Ensure data-driven screens use AsyncState pattern |
| [`dead-code`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/code-structure/dead-code.ts) | Detect unused files, exports, types, and dependencies using Knip |
| [`dependency-version-consistency`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/dependency-version-consistency.ts) | Ensures consistent dependency versions across all packages |
| [`expo-vector-icons`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/frontend/expo-vector-icons.ts) | Ensure consistent icon library usage with @expo/vector-icons |
| [`file-length-limit`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/file-length-limit.ts) | *(no description; see source)* |
| [`fitness-ignore-hygiene`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/fitness-ignore-hygiene.ts) | Validates that @fitness-ignore directives have valid check slugs and reason comments |
| [`graph-ignore-hygiene`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/graph-ignore-hygiene.ts) | Validates that @graph-ignore directives have valid graph rule ids and reason comments |
| [`graphql-offset-pagination`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/api/graphql-offset-pagination.ts) | Detect $offset variables in GraphQL queries that indicate offset-based pagination |
| [`image-optimization`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/frontend/image-optimization.ts) | Detect unoptimized image usage and recommend best practices |
| [`navigation-typing`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/frontend/navigation-typing.ts) | Verify navigation params are properly typed for type-safe routing |
| [`no-ai-attribution`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/code-structure/no-ai-attribution.ts) | Detects AI-attribution metadata in comments |
| [`no-compatibility-layer-names`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/no-compatibility-layer-names.ts) | Detects compatibility-layer, legacy-wrapper, and backward-compat declarations |
| [`no-console-log`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/code-structure/no-console-log.ts) | Disallow console.log in production code - use a structured logger |
| [`no-deprecated-tags`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/no-deprecated-tags.ts) | Detects @deprecated JSDoc tags in production code |
| [`no-non-null-assertions`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/patterns/no-non-null-assertions.ts) | Detects TypeScript non-null assertion operator (!) usage in production code — prefer proper null handling |
| [`no-process-artifacts`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/code-structure/no-process-artifacts.ts) | Detects process/planning artifacts (Phase X, Sprint X, version stamps) in comments |
| [`no-raw-regex-on-code`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/no-raw-regex-on-code.ts) | Detect regex checks that should use contentFilter: strip-strings |
| [`no-skipped-tests`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/testing/no-skipped-tests.ts) | Tests must never ship skipped, focused (.only), or placeholder |
| [`no-temporary-workarounds`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/no-temporary-workarounds.ts) | Detects HACK/FIXME comments that describe themselves as temporary |
| [`no-todo-comments`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/no-todo-comments.ts) | TODO/FIXME/XXX/OPTIMIZE markers should not ship to production |
| [`no-unimplemented-markers`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/no-unimplemented-markers.ts) | *(no description; see source)* |
| [`no-window-alert`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/no-window-alert.ts) | Disallows window.alert(), window.confirm(), and window.prompt() — use proper UI components |
| [`performance-anti-patterns`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/patterns/performance-anti-patterns.ts) | Detects common performance anti-patterns (sequential await, spread in loops) |
| [`pino-serializer-coverage`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/observability/pino-serializer-coverage.ts) | Validates that complex objects logged have proper Pino serializers |
| [`sentry-release-set`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/sentry/sentry-release-set.ts) | Detects Sentry.init() without release — cannot track regressions across deploys |
| [`sentry-source-maps`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/sentry/sentry-source-maps.ts) | Detects missing Sentry source map upload — stack traces will be unreadable |
| [`zod-openapi-sync`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/api/zod-openapi-sync.ts) | Ensures Zod schemas use .satisfies z.ZodType<> pattern |

### Resilience  *(26)*

| Slug | Description |
|---|---|
| [`batch-operation-limits`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/batch-operations.ts) | Detect batch operations that may process unbounded data |
| [`cache-ttl-validation`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/cache-ttl-validation.ts) | Validate cache TTL values for appropriate caching behavior |
| [`catch-clause-safety`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/catch-clause-safety.ts) | Detects unsafe catch clause patterns: as Error casts without instanceof, catch(e: any) |
| [`dangerous-config-defaults`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/dangerous-config-defaults.ts) | Detect dangerous default configurations |
| [`error-code-registration`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/error-code-registration.ts) | Validates that error codes used in code are registered in an error registry file |
| [`event-architecture`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/event-patterns.ts) | Validate event handling follows architectural patterns |
| [`event-handler-idempotency`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/event-patterns.ts) | Validate event handlers implement idempotency |
| [`exit-code-correctness`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/exit-code-correctness.ts) | Detect error branches that mask failures with silent success exit |
| [`graceful-shutdown`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/service-patterns.ts) | Validate services implement graceful shutdown handling |
| [`no-custom-cache`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/recovery-patterns.ts) | Enforce use of a shared cache abstraction instead of custom Map-based caches |
| [`no-custom-rate-limiter`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/recovery-patterns.ts) | Enforce use of a shared rate limiter instead of custom rate limiting implementations |
| [`no-hardcoded-timeouts`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/no-hardcoded-timeouts.ts) | Detect hardcoded timeout values that should be configurable |
| [`no-process-exit-in-finally`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/no-process-exit-in-finally.ts) | Detect process.exit() that bypasses finally cleanup |
| [`rate-limiting-coverage`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/service-patterns.ts) | Validate API endpoints have rate limiting |
| [`readline-cleanup`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/readline-cleanup.ts) | Detect readline usage without proper cleanup (close/finally) |
| [`recovery-patterns`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/recovery-patterns.ts) | Enforce use of shared recovery/retry utilities instead of hand-rolled retry loops |
| [`reentrancy-guard`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/reentrancy-guard.ts) | Detect boolean reentrancy guards that need counter/mutex semantics |
| [`retry-config-validation`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/retry-config-validation.ts) | Validate retry configs: flag excessive maxRetries (>10) and aggressive baseDelay (<100ms) |
| [`sentry-dsn-configured`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/sentry/sentry-dsn-configured.ts) | Detects Sentry.init() without a DSN — monitoring silently disabled |
| [`sentry-environment-set`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/sentry/sentry-environment-set.ts) | Detects Sentry.init() without environment — errors from all environments mixed |
| [`sentry-error-boundary`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/sentry/sentry-error-boundary.ts) | Detects React + Sentry without ErrorBoundary — render crashes go unreported |
| [`sentry-sample-rate`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/sentry/sentry-sample-rate.ts) | Detects missing or 1.0 tracesSampleRate — tracing disabled or too expensive |
| [`timer-lifecycle`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/timer-lifecycle.ts) | Detects setInterval() calls without corresponding clearInterval() cleanup — prevents timer leaks |
| [`transaction-boundary-validation`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/transaction-patterns.ts) | Validate transaction boundaries are properly managed |
| [`transaction-timeout`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/transaction-patterns.ts) | Validate transactions have timeout configurations |
| [`unbounded-memory`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/resilience/batch-operations.ts) | Detect unbounded collections and file reads that may cause OOM |

### Documentation  *(4)*

| Slug | Description |
|---|---|
| [`directive-audit`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/documentation/directive-audit.ts) | Audit suppression directives for periodic review |
| [`eslint-justifications`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/linting/eslint-justifications.ts) | Ensures all ESLint suppressions have proper justifications |
| [`no-markdown-references`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/quality/no-markdown-references.ts) | Detect markdown file references in code comments that may become stale |
| [`public-api-jsdoc`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/documentation/public-api-jsdoc.ts) | Requires JSDoc documentation on all public API exports in shared packages |

### Testing  *(4)*

| Slug | Description |
|---|---|
| [`no-stub-tests`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/testing/no-stub-tests.ts) | Detects stub tests with empty bodies, TODO-only bodies, or trivial always-passing assertions |
| [`test-convention-consistency`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/testing/test-convention-consistency.ts) | Detects mixed .test and .spec naming conventions across the codebase |
| [`test-file-naming`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/testing/test-file-naming.ts) | Validates test file naming conventions follow *.test.ts or *.spec.ts patterns |
| [`test-file-pairing`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-universal/src/checks/testing/test-file-pairing.ts) | Ensures every source file has a corresponding test file |

---

## TypeScript  *(52 checks)*

TypeScript/JavaScript projects; uses TS-AST analysis.

### Architecture  *(10)*

| Slug | Description |
|---|---|
| [`callback-invocation-safe`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/resilience/callback-invocation-safe.ts) | Class-field callbacks invoked from producer code paths (subscribers.forEach, for-of over listeners, etc.) must be wrapped in a safe<Name>(...) helper or try/catch. A throw from one subscriber must not crash the producer or skip subsequent subscribers. |
| [`circular-import-detection`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/architecture/circular-import-detection.ts) | Detects file-level circular import dependencies |
| [`contracts-schema-consistency`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/architecture/contracts-schema-consistency.ts) | Validates that contracts use Zod schemas consistently: types derived from schemas via z.infer |
| [`drizzle-orm-migration-guardrails`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/architecture/drizzle-orm-migration-guardrails.ts) | Detects dangerous patterns in Drizzle ORM migrations (raw SQL, DROP, TRUNCATE, type changes) |
| [`missing-type-exports`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/architecture/missing-type-exports.ts) | Detects types imported via deep internal paths not declared in the package exports map or barrel |
| [`module-coupling-fan-out`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/architecture/module-coupling-fan-out.ts) | Flags files with high outbound import fan-out (god-files) |
| [`no-bootstrap-tool-import`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/architecture/no-bootstrap-tool-import.ts) | The CLI host must not statically import a tool runtime — bundled tools load via the dynamic plugin path (§1 install-source independence) |
| [`package-json-exports-field`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/architecture/package-json-exports-field.ts) | *(no description; see source)* |
| [`phantom-dependency-detection`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/architecture/phantom-dependency-detection.ts) | Detect phantom dependencies (used but not declared in package.json) |
| [`tsconfig-extends-validation`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/architecture/tsconfig-extends-validation.ts) | Ensures all tsconfig.json files extend a shared base and the base file exists |

### Security  *(5)*

| Slug | Description |
|---|---|
| [`cli-realpath-validation`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/security/cli-realpath-validation.ts) | Within packages/cli/src/ and packages/core/src/plugins/, forbid the legacy `<x>.startsWith(<projectRoot>)` path-traversal guard. Use realpathSync + path.relative (or isPathInside) instead. |
| [`input-sanitization`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/security/input-sanitization.ts) | Detect unsanitized user input usage |
| [`pii-exposure-in-logs`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/observability/pii-exposure-in-logs.ts) | Detects potential PII exposure in log statements |
| [`sql-injection`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/security/sql-injection.ts) | Detect potential SQL injection vulnerabilities |
| [`unsafe-secret-comparison`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/security/unsafe-secret-comparison.ts) | Detect timing-unsafe equality comparisons on secret/token values |

### Quality  *(31)*

| Slug | Description |
|---|---|
| [`a11y-form-labels`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/frontend/a11y-form-labels.ts) | Verify form inputs have associated labels for accessibility |
| [`a11y-semantic-html`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/frontend/a11y-semantic-html.ts) | Detect View components with press handlers missing accessibilityRole |
| [`api-contract-validation`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/api/api-contract-validation.ts) | Validate API handlers have proper validation, typed responses, and error handling |
| [`api-response-validation`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/api/api-response-validation.ts) | Ensure API responses are validated with Zod schemas |
| [`array-validation`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/data-integrity/array-validation.ts) | Detect array parameters without proper validation |
| [`async-waterfall-detection`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/patterns/async-waterfall-detection.ts) | Detect sequential await statements that could be parallelized |
| [`database-index-coverage`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/data-integrity/database-index-coverage.ts) | Validate database queries have appropriate indexes |
| [`database-schema-validation`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/data-integrity/database-schema-validation.ts) | Validate database schema definitions follow best practices |
| [`dispose-pattern-completeness`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/patterns/dispose-pattern-completeness.ts) | Validate IDisposable implementations clean up all resources |
| [`duplicate-utility-functions`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/code-structure/duplicate-utility-functions.ts) | Detect duplicate and similar utility functions |
| [`error-handling-quality`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/patterns/error-handling-quality.ts) | Detect silent error handling in try/catch and Result patterns |
| [`fastify-route-validation`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/api/fastify-route-validation.ts) | Ensure all Fastify POST/PATCH/PUT routes validate request bodies with Zod schemas |
| [`fastify-schema-coverage`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/api/fastify-schema-coverage.ts) | Validate that Fastify routes have proper request/response schema validation |
| [`in-memory-repository-detection`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/data-integrity/in-memory-repository-detection.ts) | Detect repository classes using Map or in-memory storage instead of proper persistence |
| [`incomplete-regex-escaping`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/incomplete-regex-escaping.ts) | Detect incomplete regex character escaping that can lead to security vulnerabilities |
| [`lifecycle-cleanup-enforcement`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/patterns/lifecycle-cleanup-enforcement.ts) | Detect resources with lifecycle methods (destroy/close/shutdown) created without cleanup |
| [`logger-event-name-format`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/observability/logger-event-name-format.ts) | Validate logger evt fields have 3+ dot-separated segments |
| [`missing-input-validation`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/data-integrity/missing-input-validation.ts) | Detect API handlers accepting external input without validation (Zod, Joi, etc.) |
| [`no-any-types`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/code-structure/no-any-types.ts) | Detect usage of any type - use unknown with type narrowing instead |
| [`no-hardcoded-correlation-id`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/observability/no-hardcoded-correlation-id.ts) | Detect hardcoded correlation ID string literals |
| [`null-safety`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/data-integrity/null-safety.ts) | Detect unsafe property and method access without null checks |
| [`numeric-validation`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/data-integrity/numeric-validation.ts) | Detect numeric parameters without NaN/Infinity/range validation |
| [`result-pattern-consistency`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/patterns/result-pattern-consistency.ts) | Ensures consistent use of Result<T,E> for expected failures and throw for unexpected failures |
| [`silent-early-returns`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/patterns/silent-early-returns.ts) | Detect single-line early returns without logging |
| [`stream-buffer-size-limits`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/patterns/stream-buffer-size-limits.ts) | Detects Buffer.concat() and stream buffering without size limit guards |
| [`stubbed-implementation-detection`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/stubbed-implementation-detection.ts) | Detects incomplete/placeholder implementations |
| [`test-only-frontend-modules`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/frontend/test-only-frontend-modules.ts) | Detects frontend code only imported by test files |
| [`throws-documentation`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/patterns/throws-documentation.ts) | Detects functions with throw statements but no @throws JSDoc |
| [`toctou-race-condition`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/patterns/toctou-race-condition.ts) | Detects read-then-update patterns without atomic guarantees |
| [`typescript-frontend`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/linting/typescript-frontend.ts) | Validates TypeScript compilation for frontend apps |
| [`unused-config-options`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/quality/unused-config-options.ts) | Detects configuration properties defined but never accessed |

### Resilience  *(5)*

| Slug | Description |
|---|---|
| [`context-leakage`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/resilience/context-leakage.ts) | Detect potential request context leakage |
| [`context-mutation`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/resilience/context-mutation.ts) | Detect unsafe mutations of request/execution context |
| [`detached-promises`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/resilience/detached-promises.ts) | Detect promises that may not be awaited (potential silent failures) |
| [`no-raw-fetch`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/resilience/no-raw-fetch.ts) | Detect direct fetch() calls that should use wrapped HTTP clients |
| [`no-unbounded-concurrency`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/resilience/no-unbounded-concurrency.ts) | Detect Promise.all with unbounded concurrency |

### Testing  *(1)*

| Slug | Description |
|---|---|
| [`mock-implementations-in-production`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-typescript/src/checks/testing/mock-implementations-in-production.ts) | Detects mock, stub, or fake implementations in production code |

---

## Python  *(2 checks)*

Python projects.

### Quality  *(2)*

| Slug | Description |
|---|---|
| [`python-function-too-long`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-python/src/checks/function-too-long.ts) | Python functions should stay under a line budget for readability and testability |
| [`python-no-bare-except`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-python/src/checks/no-bare-except.ts) | Bare except clauses catch system-exiting exceptions like KeyboardInterrupt |

---

## Go  *(1 check)*

Go projects.

### Quality  *(1)*

| Slug | Description |
|---|---|
| [`go-no-fmt-print`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-go/src/checks/no-fmt-print.ts) | *(no description; see source)* |

---

## Java  *(1 check)*

Java projects.

### Quality  *(1)*

| Slug | Description |
|---|---|
| [`java-no-print-stack-trace`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-java/src/checks/no-printstacktrace.ts) | e.printStackTrace() bypasses the logging framework — use a logger instead |

---

## C / C++  *(1 check)*

C/C++ projects.

### Quality  *(1)*

| Slug | Description |
|---|---|
| [`cpp-clang-tidy`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-cpp/src/checks/clang-tidy-passthrough.ts) | Run clang-tidy and surface its diagnostics as opensip-tools violations |

---

## Rust  *(1 check)*

Rust projects.

### Quality  *(1)*

| Slug | Description |
|---|---|
| [`rust-no-dbg-macro`](https://github.com/opensip-ai/opensip-tools/blob/main/packages/fitness/checks-rust/src/checks/no-dbg-macro.ts) | *(no description; see source)* |

---

## How to use a check

Every check above is loaded automatically when its pack is in your project's `node_modules/`. To target one explicitly:

```bash
opensip-tools fit --check <slug>           # run one check
opensip-tools fit --tags security          # run all checks tagged security
opensip-tools fit --recipe quick-smoke     # run a named lineup
```

Per-check parameter overrides go in your recipe under `config:` — see [recipes and checks](/docs/opensip-tools/20-fit/01-recipes-and-checks/).

To write your own check, see [plugin authoring](/docs/opensip-tools/50-extend/01-plugin-authoring/).
