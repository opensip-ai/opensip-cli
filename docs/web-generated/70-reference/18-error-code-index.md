---
status: current
last_verified: 2026-07-24
release: v0.8.4
title: "Error code index"
audience: [contributors, operators, agents]
purpose: "Generated registry of registered OpenSIP error codes with axes and operator actions."
generated: true
---

# Error code index

> **Generated.** Do not hand-edit. Run `pnpm docs:error-index` after catalog changes. This lists **registered** definitions only; the set grows as packages register catalogs.

- Catalog sources: **5**
- Definitions: **18**

## Catalogs

| Package | Owner id | Source file | Count |
|---|---|---|---:|
| `@opensip-cli/core` | `opensip-cli.core` | `packages/core/src/lib/error-definition.ts` | 10 |
| `@opensip-cli/fitness` | `afd68bd3-ff3c-4935-a5b6-76d8fc7a5224` | `packages/fitness/engine/src/errors/fitness-error-catalog.ts` | 3 |
| `@opensip-cli/simulation` | `simulation` | `packages/simulation/engine/src/errors/simulation-error-catalog.ts` | 1 |
| `@opensip-cli/external-tool-adapter` | `external-tool-adapter` | `packages/external-tool-adapter/src/errors/external-tool-error-catalog.ts` | 2 |
| `@opensip-cli/mcp` | `mcp` | `packages/mcp/src/errors/mcp-error-catalog.ts` | 2 |

## Codes

| Code | Package | Source | Responsibility | Kind | Retry | Severity | Exit | Lifecycle | Operator action |
|---|---|---|---|---|---|---|---|---|---|
| `CONFIG.UNKNOWN_CHECK` | `@opensip-cli/fitness` | application | user | validation | never | error | configuration | active | Run opensip fit list to see available checks. |
| `CONFIGURATION_ERROR` | `@opensip-cli/core` | application | user | validation | never | error | configuration | active | Check opensip-cli.config.yml and CLI flags. |
| `CORE.SYSTEM.CANCELLED` | `@opensip-cli/core` | application | user | cancelled | never | error | cancelled | active | The operation was cancelled. Re-run if the work is still needed. |
| `EXTERNAL.SCANNER.BINARY_MISSING` | `@opensip-cli/external-tool-adapter` | external | operator | not-found | never | error | configuration | active | Install the scanner binary, add it to PATH, or set the tool binary path config/env pin. |
| `EXTERNAL.SCANNER.SPAWN_FAILED` | `@opensip-cli/external-tool-adapter` | infrastructure | environment | I/O | caller-policy | error | runtime | active | Check binary permissions and OS errno; retry after fixing the environment. |
| `MCP.STDIO.PROTOCOL` | `@opensip-cli/mcp` | application | tool-author | compatibility | never | error | runtime | active | Fix the JSON-RPC request shape and reconnect the MCP client. |
| `MCP.STDIO.SHUTDOWN` | `@opensip-cli/mcp` | application | user | cancelled | never | error | cancelled | active | MCP server shut down. Restart opensip mcp if more queries are needed. |
| `NETWORK_ERROR` | `@opensip-cli/core` | external | environment | network | transient | error | report-failed | active | Check network connectivity and the remote endpoint. |
| `NOT_FOUND` | `@opensip-cli/core` | application | user | not-found | never | error | not-found | active | Verify the resource name and list available options. |
| `PLUGIN_INCOMPATIBLE` | `@opensip-cli/core` | application | user | compatibility | never | error | plugin-incompatible | active | Upgrade OpenSIP CLI or the tool, or trust a project-local tool via tools.trusted. |
| `RESOURCE.NOT_FOUND.RECIPE` | `@opensip-cli/fitness` | application | user | not-found | never | error | not-found | active | Run opensip fit recipes to list available recipes. |
| `SIMULATION.SCENARIO.ABORTED` | `@opensip-cli/simulation` | application | user | cancelled | never | error | cancelled | active | Scenario was cancelled. Re-run if the work is still needed. |
| `SYSTEM_ERROR` | `@opensip-cli/core` | application | tool-author | invariant | never | error | runtime | active | Retry once; if it persists, capture the run id and report a bug. |
| `SYSTEM.FITNESS.SESSION_IN_PROGRESS` | `@opensip-cli/fitness` | application | tool-author | conflict | never | error | runtime | active | Wait for the active fitness session to finish or abort it. |
| `TIMEOUT` | `@opensip-cli/core` | infrastructure | environment | timeout | caller-policy | error | runtime | active | Increase the deadline or reduce workload; check for hung dependencies. |
| `UNKNOWN_FAILURE` | `@opensip-cli/core` | application | unknown | invariant | never | fatal | fatal | active | Capture the run id and operator detail; do not retry blindly. |
| `UNKNOWN_LIVE_VIEW` | `@opensip-cli/core` | application | tool-author | not-found | never | error | runtime | active | Use a registered live view key for this tool. |
| `VALIDATION_ERROR` | `@opensip-cli/core` | application | user | validation | never | error | configuration | active | Fix the invalid input, flag, or configuration value and retry. |

## See also

- [Error and resiliency model](/docs/opensip-cli/80-implementation/09-error-and-resiliency-model/)
- [ADR-0181 structured error definitions](https://github.com/opensip-ai/opensip-cli/blob/v0.8.4/docs/decisions/ADR-0181-structured-error-definitions-and-failure-envelope.md)
