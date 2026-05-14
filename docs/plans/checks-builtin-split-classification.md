# checks-builtin split — classification table

Inputs: every check definition in `packages/checks-builtin/src/checks/` as of
the start of the split refactor (B1 task #37).

Classification rule (Workstream B, decided 2026-05-14):
- **TS_AST** — imports the TypeScript compiler API (`typescript`,
  `parseSource`, `walkNodes`, `getASTLineNumber`, `ts` re-export from
  `@opensip-tools/core`), reads/parses TS-specific config (tsconfig,
  package.json#exports), or is conceptually only meaningful inside the
  TS/Node ecosystem (drizzle-orm, typed-inject, react-specific).
- **UNIVERSAL** — operates on raw text, regex, file globs, or
  language-agnostic config (Docker, .env, READMEs, generic file
  structure). Could apply to any codebase regardless of language.

Ambiguous cases default to TS_AST (conservative — easier to relax later
than to walk back a misclassification).

| Path | Slug | Bucket |
|------|------|--------|
| no-eval.ts | no-eval | UNIVERSAL |
| no-console-log.ts | no-console-log | UNIVERSAL |
| architecture/circular-import-detection.ts | circular-import-detection | TS_AST |
| architecture/contracts-schema-consistency.ts | contracts-schema-consistency | TS_AST |
| architecture/dependencies/no-duplicate-packages.ts | no-duplicate-packages | UNIVERSAL |
| architecture/dependencies/phantom-dependency-detection.ts | phantom-dependency-detection | UNIVERSAL |
| architecture/di-static-inject-usage.ts | di-static-inject-usage | TS_AST |
| architecture/docker-best-practices.ts | docker-best-practices | UNIVERSAL |
| architecture/docker-ignore-validation.ts | docker-ignore-validation | UNIVERSAL |
| architecture/docker-version-sync.ts | docker-version-sync | UNIVERSAL |
| architecture/drizzle-orm-migration-guardrails.ts | drizzle-orm-migration-guardrails | TS_AST |
| architecture/env-var-validation.ts | env-var-validation | UNIVERSAL |
| architecture/heavy-import-detection.ts | heavy-import-detection | UNIVERSAL |
| architecture/missing-type-exports.ts | missing-type-exports | TS_AST |
| architecture/module-coupling-fan-out.ts | module-coupling-fan-out | TS_AST |
| architecture/modules/empty-package-detection.ts | empty-package-detection | UNIVERSAL |
| architecture/modules/interface-implementation-consistency.ts | interface-implementation-consistency | UNIVERSAL |
| architecture/modules/unused-modules.ts | unused-modules | TS_AST |
| architecture/no-custom-event-emitter.ts | no-custom-event-emitter | UNIVERSAL |
| architecture/node-version-consistency.ts | node-version-consistency | UNIVERSAL |
| architecture/package-json-exports-field.ts | package-json-exports-field | TS_AST |
| architecture/project-readme-existence.ts | project-readme-existence | UNIVERSAL |
| architecture/stale-build-artifacts.ts | stale-build-artifacts | UNIVERSAL |
| architecture/tsconfig-extends-validation.ts | tsconfig-extends-validation | TS_AST |
| architecture/typed-inject-scope-mismatch.ts | typed-inject-scope-mismatch | TS_AST |
| documentation/directive-audit.ts | directive-audit | UNIVERSAL |
| documentation/public-api-jsdoc.ts | public-api-jsdoc | UNIVERSAL |
| quality/api/api-contract-validation.ts | api-contract-validation | TS_AST |
| quality/api/api-response-validation.ts | api-response-validation | TS_AST |
| quality/api/fastify-route-validation.ts | fastify-route-validation | TS_AST |
| quality/api/fastify-schema-coverage.ts | fastify-schema-coverage | TS_AST |
| quality/api/graphql-offset-pagination.ts | graphql-offset-pagination | UNIVERSAL |
| quality/api/openapi-response-coverage.ts | openapi-response-coverage | TS_AST |
| quality/api/openapi-type-source.ts | openapi-type-source | TS_AST |
| quality/api/zod-openapi-sync.ts | zod-openapi-sync | UNIVERSAL |
| quality/code-structure/comment-quality.ts | comment-quality | UNIVERSAL |
| quality/code-structure/dead-code.ts | dead-code | UNIVERSAL |
| quality/code-structure/duplicate-utility-functions.ts | duplicate-utility-functions | TS_AST |
| quality/code-structure/no-any-types.ts | no-any-types | TS_AST |
| quality/code-structure/no-console-log.ts | no-console-log | UNIVERSAL |
| quality/code-structure/todo-comments.ts | todo-comments | UNIVERSAL |
| quality/data-integrity/array-validation.ts | array-validation | TS_AST |
| quality/data-integrity/database-index-coverage.ts | database-index-coverage | TS_AST |
| quality/data-integrity/database-schema-validation.ts | database-schema-validation | TS_AST |
| quality/data-integrity/dynamodb-scan-detection.ts | dynamodb-scan-detection | TS_AST |
| quality/data-integrity/financial-transaction-ordering.ts | financial-transaction-ordering | TS_AST |
| quality/data-integrity/in-memory-repository-detection.ts | in-memory-repository-detection | TS_AST |
| quality/data-integrity/missing-input-validation.ts | missing-input-validation | TS_AST |
| quality/data-integrity/null-safety.ts | null-safety | TS_AST |
| quality/data-integrity/numeric-validation.ts | numeric-validation | TS_AST |
| quality/data-integrity/postgres-n-plus-one.ts | postgres-n-plus-one | TS_AST |
| quality/data-integrity/typeorm-n-plus-one.ts | typeorm-n-plus-one | TS_AST |
| quality/dependency-security-audit.ts | dependency-security-audit | UNIVERSAL |
| quality/dependency-version-consistency.ts | dependency-version-consistency | UNIVERSAL |
| quality/fitness-ignore-hygiene.ts | fitness-ignore-hygiene | UNIVERSAL |
| quality/frontend/a11y-form-labels.ts | a11y-form-labels | TS_AST |
| quality/frontend/a11y-semantic-html.ts | a11y-semantic-html | TS_AST |
| quality/frontend/accessible-touchables.ts | accessible-touchables | TS_AST |
| quality/frontend/client-boundary-placement.ts | client-boundary-placement | TS_AST |
| quality/frontend/expo-vector-icons.ts | expo-vector-icons | UNIVERSAL |
| quality/frontend/flashlist-enforcement.ts | flashlist-enforcement | TS_AST |
| quality/frontend/image-optimization.ts | image-optimization | UNIVERSAL |
| quality/frontend/lazy-loading.ts | lazy-loading | TS_AST |
| quality/frontend/memo-list-items.ts | memo-list-items | TS_AST |
| quality/frontend/navigation-typing.ts | navigation-typing | UNIVERSAL |
| quality/frontend/no-inline-functions.ts | no-inline-functions | TS_AST |
| quality/frontend/platform-checks.ts | platform-checks | TS_AST |
| quality/frontend/test-only-frontend-modules.ts | test-only-frontend-modules | TS_AST |
| quality/incomplete-regex-escaping.ts | incomplete-regex-escaping | TS_AST |
| quality/linting/eslint-justifications.ts | eslint-justifications | UNIVERSAL |
| quality/linting/semgrep-justifications.ts | semgrep-justifications | UNIVERSAL |
| quality/linting/typescript-directive-hygiene.ts | typescript-directive-hygiene | UNIVERSAL |
| quality/linting/typescript-frontend.ts | typescript-frontend | TS_AST |
| quality/no-legacy-code.ts | no-legacy-code | UNIVERSAL |
| quality/no-markdown-references.ts | no-markdown-references | UNIVERSAL |
| quality/no-raw-regex-on-code.ts | no-raw-regex-on-code | UNIVERSAL |
| quality/no-window-alert.ts | no-window-alert | UNIVERSAL |
| quality/observability/logger-event-name-format.ts | logger-event-name-format | TS_AST |
| quality/observability/no-hardcoded-correlation-id.ts | no-hardcoded-correlation-id | TS_AST |
| quality/observability/pii-exposure-in-logs.ts | pii-exposure-in-logs | TS_AST |
| quality/observability/pino-serializer-coverage.ts | pino-serializer-coverage | UNIVERSAL |
| quality/patterns/async-state-pattern.ts | async-state-pattern | UNIVERSAL |
| quality/patterns/async-waterfall-detection.ts | async-waterfall-detection | TS_AST |
| quality/patterns/dispose-pattern-completeness.ts | dispose-pattern-completeness | TS_AST |
| quality/patterns/error-handling-quality.ts | error-handling-quality | TS_AST |
| quality/patterns/lifecycle-cleanup-enforcement.ts | lifecycle-cleanup-enforcement | TS_AST |
| quality/patterns/no-non-null-assertions.ts | no-non-null-assertions | UNIVERSAL |
| quality/patterns/performance-anti-patterns.ts | performance-anti-patterns | UNIVERSAL |
| quality/patterns/result-pattern-consistency.ts | result-pattern-consistency | TS_AST |
| quality/patterns/silent-early-returns.ts | silent-early-returns | TS_AST |
| quality/patterns/stream-buffer-size-limits.ts | stream-buffer-size-limits | TS_AST |
| quality/patterns/throws-documentation.ts | throws-documentation | TS_AST |
| quality/patterns/toctou-race-condition.ts | toctou-race-condition | TS_AST |
| quality/security-scan-suite.ts | security-scan-suite | UNIVERSAL |
| quality/stubbed-implementation-detection.ts | stubbed-implementation-detection | TS_AST |
| quality/test-only-implementations.ts | test-only-implementations | TS_AST |
| quality/unused-config-options.ts | unused-config-options | TS_AST |
| resilience/async-patterns.ts | async-patterns | TS_AST |
| resilience/batch-operations.ts | batch-operations | UNIVERSAL |
| resilience/cache-ttl-validation.ts | cache-ttl-validation | UNIVERSAL |
| resilience/catch-clause-safety.ts | catch-clause-safety | UNIVERSAL |
| resilience/context-safety.ts | context-safety | TS_AST |
| resilience/dangerous-config-defaults.ts | dangerous-config-defaults | UNIVERSAL |
| resilience/error-code-registration.ts | error-code-registration | UNIVERSAL |
| resilience/event-patterns.ts | event-patterns | UNIVERSAL |
| resilience/exit-code-correctness.ts | exit-code-correctness | UNIVERSAL |
| resilience/no-hardcoded-timeouts.ts | no-hardcoded-timeouts | UNIVERSAL |
| resilience/no-process-exit-in-finally.ts | no-process-exit-in-finally | UNIVERSAL |
| resilience/readline-cleanup.ts | readline-cleanup | UNIVERSAL |
| resilience/recovery-patterns.ts | recovery-patterns | UNIVERSAL |
| resilience/reentrancy-guard.ts | reentrancy-guard | UNIVERSAL |
| resilience/retry-config-validation.ts | retry-config-validation | UNIVERSAL |
| resilience/sentry/sentry-dsn-configured.ts | sentry-dsn-configured | UNIVERSAL |
| resilience/sentry/sentry-environment-set.ts | sentry-environment-set | UNIVERSAL |
| resilience/sentry/sentry-error-boundary.ts | sentry-error-boundary | UNIVERSAL |
| resilience/sentry/sentry-pii-scrubbing.ts | sentry-pii-scrubbing | UNIVERSAL |
| resilience/sentry/sentry-release-set.ts | sentry-release-set | UNIVERSAL |
| resilience/sentry/sentry-sample-rate.ts | sentry-sample-rate | UNIVERSAL |
| resilience/sentry/sentry-source-maps.ts | sentry-source-maps | UNIVERSAL |
| resilience/service-patterns.ts | service-patterns | UNIVERSAL |
| resilience/timer-lifecycle.ts | timer-lifecycle | UNIVERSAL |
| resilience/transaction-patterns.ts | transaction-patterns | UNIVERSAL |
| security/api-key-rotation.ts | api-key-rotation | UNIVERSAL |
| security/auth-middleware-coverage.ts | auth-middleware-coverage | UNIVERSAL |
| security/auth-route-guard.ts | auth-route-guard | UNIVERSAL |
| security/cors-configuration.ts | cors-configuration | UNIVERSAL |
| security/csp-headers.ts | csp-headers | UNIVERSAL |
| security/env-secret-exposure.ts | env-secret-exposure | UNIVERSAL |
| security/hasura-production-config.ts | hasura-production-config | UNIVERSAL |
| security/input-sanitization.ts | input-sanitization | TS_AST |
| security/jwt-validation.ts | jwt-validation | UNIVERSAL |
| security/no-eval.ts | no-eval | UNIVERSAL |
| security/no-hardcoded-secrets.ts | no-hardcoded-secrets | UNIVERSAL |
| security/pii-logging.ts | pii-logging | UNIVERSAL |
| security/rate-limit-coverage.ts | rate-limit-coverage | UNIVERSAL |
| security/semgrep-scan.ts | semgrep-scan | UNIVERSAL |
| security/sql-injection.ts | sql-injection | TS_AST |
| security/unsafe-secret-comparison.ts | unsafe-secret-comparison | TS_AST |
| security/use-centralized-crypto.ts | use-centralized-crypto | UNIVERSAL |
| security/webhook-signature-verification.ts | webhook-signature-verification | UNIVERSAL |
| testing/mock-implementations-in-production.ts | mock-implementations-in-production | TS_AST |
| testing/no-focused-tests.ts | no-focused-tests | UNIVERSAL |
| testing/no-skipped-tests.ts | no-skipped-tests | UNIVERSAL |
| testing/no-stub-tests.ts | no-stub-tests | UNIVERSAL |
| testing/no-test-only-skip.ts | no-test-only-skip | UNIVERSAL |
| testing/test-convention-consistency.ts | test-convention-consistency | UNIVERSAL |
| testing/test-file-naming.ts | test-file-naming | UNIVERSAL |
| testing/test-file-pairing.ts | test-file-pairing | UNIVERSAL |
