---
status: current
last_verified: 2026-07-26
release: v0.8.4
title: "Error code index"
audience: [contributors, operators, agents]
purpose: "Generated registry of registered OpenSIP error codes with axes and operator actions."
generated: true
---

# Error code index

> **Generated.** Do not hand-edit. Run `pnpm docs:error-index` after catalog changes. This lists **registered** definitions only; the set grows as packages register catalogs.

- Catalog sources: **13**
- Definitions: **117**

## Catalogs

| Package | Owner id | Source file | Count |
|---|---|---|---:|
| `@opensip-cli/core` | `opensip-cli.core` | `packages/core/src/lib/error-definition.ts` | 13 |
| `@opensip-cli/fitness` | `afd68bd3-ff3c-4935-a5b6-76d8fc7a5224` | `packages/fitness/engine/src/errors/fitness-error-catalog.ts` | 3 |
| `@opensip-cli/simulation` | `simulation` | `packages/simulation/engine/src/errors/simulation-error-catalog.ts` | 1 |
| `@opensip-cli/external-tool-adapter` | `external-tool-adapter` | `packages/external-tool-adapter/src/errors/external-tool-error-catalog.ts` | 3 |
| `@opensip-cli/mcp` | `mcp` | `packages/mcp/src/errors/mcp-error-catalog.ts` | 2 |
| `@opensip-cli/codebase` | `@opensip-cli/codebase` | `packages/codebase/src/errors/codebase-error-catalog.ts` | 2 |
| `@opensip-cli/tree-sitter` | `@opensip-cli/tree-sitter` | `packages/tree-sitter/src/errors/tree-sitter-error-catalog.ts` | 2 |
| `@opensip-cli/core` | `opensip-cli.core` | `packages/core/src/lib/errors/definitions/runtime-coordination.ts` | 10 |
| `@opensip-cli/core` | `opensip-cli.core` | `packages/core/src/lib/errors/definitions/runtime-lease.ts` | 20 |
| `@opensip-cli/core` | `opensip-cli.core` | `packages/core/src/lib/errors/definitions/file-lock.ts` | 11 |
| `@opensip-cli/core` | `opensip-cli.core` | `packages/core/src/lib/errors/definitions/tool-contract.ts` | 18 |
| `@opensip-cli/core` | `opensip-cli.core` | `packages/core/src/lib/errors/definitions/plugin-capability.ts` | 15 |
| `@opensip-cli/core` | `opensip-cli.core` | `packages/core/src/lib/errors/definitions/config-and-runtime.ts` | 17 |

## Codes

| Code | Package | Source | Responsibility | Kind | Retry | Severity | Exit | Lifecycle | Operator action |
|---|---|---|---|---|---|---|---|---|---|
| `CAPABILITY.CONTRIBUTION.SCHEMA_MISMATCH` | `@opensip-cli/core` | application | tool-author | validation | never | error | plugin-incompatible | active | Export the capability contribution in the documented shape (an array for list-valued contributions). |
| `CONFIG.UNKNOWN_CHECK` | `@opensip-cli/fitness` | application | user | validation | never | error | configuration | active | Run opensip fit list to see available checks. |
| `CONFIGURATION_ERROR` | `@opensip-cli/core` | application | user | validation | never | error | configuration | active | Check opensip-cli.config.yml and CLI flags. |
| `CONFIGURATION.AGENT_FILTER.EMPTY_TOKEN` | `@opensip-cli/core` | application | user | validation | never | error | configuration | active | Remove the empty --filter token, or give it a value. |
| `CONFIGURATION.AGENT_FILTER.INVALID_TOP` | `@opensip-cli/core` | application | user | validation | never | error | configuration | active | Pass a non-negative whole number to --top. |
| `CONFIGURATION.AGENT_FILTER.MISSING_ARGUMENT` | `@opensip-cli/core` | application | user | validation | never | error | configuration | active | Supply a value after the filter prefix, e.g. --filter category:security. |
| `CONFIGURATION.AGENT_FILTER.UNKNOWN_TOKEN` | `@opensip-cli/core` | application | user | validation | never | error | configuration | active | Use one of the filter tokens listed in the message. |
| `CONFIGURATION.CONFIG.EXPLICIT_PATH_MISSING` | `@opensip-cli/core` | application | user | not-found | never | error | configuration | active | Correct the --config path, or omit --config to discover the config file. |
| `CONFIGURATION.CONFIG.NOT_FOUND` | `@opensip-cli/core` | application | user | not-found | never | error | configuration | active | Run `opensip init` to create opensip-cli.config.yml, or pass --config with the path to an existing one. |
| `CONFIGURATION.GATE.MUTUALLY_EXCLUSIVE_FLAGS` | `@opensip-cli/core` | application | user | validation | never | error | configuration | active | Pass either --gate-save or --gate-compare, not both. |
| `CONFIGURATION.TOOL_NAMESPACE.NOT_AN_OBJECT` | `@opensip-cli/core` | application | user | validation | never | error | configuration | active | Make the named tool configuration block a mapping of keys to values, or remove it. |
| `CONFIGURATION.TOOL_NAMESPACE.PARSE_FAILED` | `@opensip-cli/core` | application | user | validation | never | error | configuration | active | Correct the named tool configuration block in opensip-cli.config.yml; the schema issues are listed on the error cause. |
| `CORE.BASELINE.FINGERPRINT_STRATEGY_FAILED` | `@opensip-cli/core` | application | tool-author | invariant | never | warning | success | active | The fingerprint strategy returned an unusable value; findings are reported un-stamped for this run. Report it to the tool author. |
| `CORE.BASELINE.FINGERPRINT_STRATEGY_INVALID_FINGERPRINT` | `@opensip-cli/core` | application | tool-author | validation | never | error | plugin-incompatible | active | Declare `fingerprint` as a function on the fingerprint strategy descriptor. |
| `CORE.BASELINE.FINGERPRINT_STRATEGY_INVALID_ID` | `@opensip-cli/core` | application | tool-author | validation | never | error | plugin-incompatible | active | Give the fingerprint strategy a non-empty id. |
| `CORE.BASELINE.FINGERPRINT_STRATEGY_INVALID_VERSION` | `@opensip-cli/core` | application | tool-author | validation | never | error | plugin-incompatible | active | Give the fingerprint strategy a positive integer version. |
| `CORE.COMMAND_INVENTORY.DUPLICATE_PATH` | `@opensip-cli/core` | application | tool-author | validation | never | error | plugin-incompatible | active | Give each command inventory leaf a distinct command path. |
| `CORE.COMMAND_INVENTORY.HANDLER_CLAIM_INVALID` | `@opensip-cli/core` | application | tool-author | validation | never | error | plugin-incompatible | active | Only claim a static handler from the package that declares it; correct the leaf handler claim. |
| `CORE.COMMAND_INVENTORY.INVALID` | `@opensip-cli/core` | application | tool-author | validation | never | error | plugin-incompatible | active | Correct the runtime command inventory shape; see the named field in the message. |
| `CORE.COMMAND_INVENTORY.LIMIT_EXCEEDED` | `@opensip-cli/core` | application | tool-author | resource | never | error | plugin-incompatible | active | Reduce the number of declared commands, or split them across tools; the inventory bound protects host bootstrap. |
| `CORE.EPHEMERAL_CACHE.IDENTITY_CHANGED` | `@opensip-cli/core` | infrastructure | environment | integrity | never | error | configuration | active | The user cache directory changed identity while it was in use. Remove the named cache directory and re-run. |
| `CORE.EPHEMERAL_CACHE.PREPARE_FAILED` | `@opensip-cli/core` | infrastructure | environment | I/O | caller-policy | error | runtime | active | The user cache directory could not be created. Check the reported errno, free space, and permissions on the parent directory. |
| `CORE.EPHEMERAL_CACHE.UNSAFE_POSTURE` | `@opensip-cli/core` | infrastructure | environment | security | never | error | configuration | active | The user cache directory is not owned by this user or is world-writable. Fix its ownership and permissions, or remove it so opensip can recreate it. |
| `CORE.ERROR_DEFINITION.INVALID` | `@opensip-cli/core` | application | tool-author | validation | never | error | plugin-incompatible | active | Correct the error definition or catalog named in the message; see the error-code index for the required shape. |
| `CORE.LOCK.ACQUIRE_TIMEOUT` | `@opensip-cli/core` | infrastructure | environment | timeout | transient | error | runtime | active | Another opensip run holds this lock. Wait for it to finish and re-run; if no such run exists, remove the stale lock file named in the message. |
| `CORE.LOCK.INVALID_POLICY` | `@opensip-cli/core` | application | user | validation | never | error | configuration | active | Set the lock policy duration to a positive number of milliseconds within the supported range, then re-run. |
| `CORE.LOCK.MALFORMED` | `@opensip-cli/core` | infrastructure | environment | security | never | error | configuration | active | The lock path is not a regular file. Remove or replace the named path, then re-run. |
| `CORE.LOCK.METADATA_TOO_LARGE` | `@opensip-cli/core` | application | tool-author | validation | never | error | runtime | active | Reduce the lock record metadata below the documented size bound. |
| `CORE.LOCK.UNSAFE_MODE` | `@opensip-cli/core` | infrastructure | environment | security | never | error | configuration | active | The lock file could not be restricted to owner-only permissions. Check the umask and the filesystem mount options for the runtime directory. |
| `CORE.LOCK.UNSAFE_PUBLICATION` | `@opensip-cli/core` | infrastructure | environment | integrity | transient | error | configuration | active | The lock record could not be published safely. Re-run; if it repeats, the runtime directory may be on a filesystem without reliable hard links. |
| `CORE.LOCK.UNSAFE_TEMP` | `@opensip-cli/core` | infrastructure | environment | integrity | transient | error | configuration | active | The lock temporary file could not be verified as private and complete. Re-run; if it repeats, check for another process writing into the runtime directory. |
| `CORE.LOCK.WRITE_STALLED` | `@opensip-cli/core` | infrastructure | environment | resource | caller-policy | error | runtime | active | A lock write stalled. Check free space and file-descriptor limits for the runtime directory, then retry. |
| `CORE.REGISTRY.DUPLICATE` | `@opensip-cli/core` | application | user | validation | never | error | configuration | active | Two entries share one id. Rename or remove the duplicate named in the message, then re-run. |
| `CORE.REGISTRY.NAME_COLLISION` | `@opensip-cli/core` | application | user | validation | never | error | configuration | active | Two entries claim the same name. Rename one of the entries named in the message, then re-run. |
| `CORE.RUNTIME_COORDINATION.BUSY` | `@opensip-cli/core` | infrastructure | environment | conflict | transient | error | runtime | active | Another opensip run is holding this coordination record. Wait for it to finish, or re-run — this resolves itself. |
| `CORE.RUNTIME_COORDINATION.CONFLICT` | `@opensip-cli/core` | application | environment | conflict | transient | error | runtime | active | Another opensip operation currently holds this state. Wait for it to finish and re-run. |
| `CORE.RUNTIME_COORDINATION.CORRUPT_RECORD` | `@opensip-cli/core` | infrastructure | environment | integrity | never | error | configuration | active | A runtime coordination record is corrupt. Remove the named record and re-run; no project data is affected. |
| `CORE.RUNTIME_COORDINATION.PROBE_FAILED` | `@opensip-cli/core` | infrastructure | environment | I/O | caller-policy | error | runtime | active | A runtime coordination path could not be inspected. Check the reported errno and the permissions on the runtime directory. |
| `CORE.RUNTIME_COORDINATION.RECLAIM_SKIPPED` | `@opensip-cli/core` | infrastructure | environment | conflict | transient | warning | success | active | An abandoned runtime record was left in place this run and will be reclaimed later. No action required. |
| `CORE.RUNTIME_COORDINATION.UNSAFE_STATE` | `@opensip-cli/core` | infrastructure | environment | security | never | error | configuration | active | Inspect the runtime coordination directory for unexpected or symlinked entries and remove them, then re-run. |
| `CORE.RUNTIME_LEASE.CAPACITY` | `@opensip-cli/core` | infrastructure | environment | resource | caller-policy | error | runtime | active | A runtime coordination bound is exhausted. Reduce concurrent opensip runs or nesting depth, then retry. |
| `CORE.RUNTIME_LEASE.INHERITANCE_DENIED` | `@opensip-cli/core` | application | environment | conflict | transient | error | runtime | active | This run cannot inherit the parent runtime lease. Let the queued writer finish, then re-run. |
| `CORE.RUNTIME_RECOVERY.PROBE_FAILED` | `@opensip-cli/core` | infrastructure | environment | I/O | caller-policy | error | runtime | active | The recovery header could not be read. Check the reported errno and the permissions on the runtime directory before retrying. |
| `CORE.RUNTIME_RECOVERY.REQUIRED` | `@opensip-cli/core` | application | user | conflict | never | error | configuration | active | A previous opensip init or uninstall was interrupted. Run `opensip init` to complete recovery before retrying. |
| `CORE.SUBPROCESS.GIT_FAILED` | `@opensip-cli/core` | external | environment | I/O | caller-policy | warning | success | active | git could not be run, so changed-file detection is unavailable this run. Check that git is installed and the directory is a repository. |
| `CORE.SYSTEM.CANCELLED` | `@opensip-cli/core` | application | user | cancelled | never | error | cancelled | active | The operation was cancelled. Re-run if the work is still needed. |
| `CORE.SYSTEM.DEADLINE_EXCEEDED` | `@opensip-cli/core` | infrastructure | environment | timeout | never | error | runtime | active | Increase the outer deadline or reduce the operation workload. |
| `CORE.SYSTEM.PERMISSION` | `@opensip-cli/core` | infrastructure | environment | permission | never | error | runtime | active | Check filesystem permissions for the affected path. |
| `CORE.SYSTEM.RESOURCE` | `@opensip-cli/core` | infrastructure | environment | resource | caller-policy | error | runtime | active | Free resources (disk, file descriptors, or memory) and retry. |
| `EXTERNAL.SCANNER.BINARY_MISSING` | `@opensip-cli/external-tool-adapter` | external | operator | not-found | never | error | configuration | active | Install the scanner binary, add it to PATH, or set the tool binary path config/env pin. |
| `EXTERNAL.SCANNER.KILLED_BY_SIGNAL` | `@opensip-cli/external-tool-adapter` | infrastructure | environment | I/O | caller-policy | error | runtime | active | The scanner was killed by an external signal (OOM killer, kill -9, container stop). Check system memory and process limits, then retry. |
| `EXTERNAL.SCANNER.SPAWN_FAILED` | `@opensip-cli/external-tool-adapter` | infrastructure | environment | I/O | caller-policy | error | runtime | active | Check binary permissions and OS errno; retry after fixing the environment. |
| `MCP.STDIO.PROTOCOL` | `@opensip-cli/mcp` | application | tool-author | compatibility | never | error | runtime | active | Fix the JSON-RPC request shape and reconnect the MCP client. |
| `MCP.STDIO.SHUTDOWN` | `@opensip-cli/mcp` | application | user | cancelled | never | error | cancelled | active | MCP server shut down. Restart opensip mcp if more queries are needed. |
| `NETWORK_ERROR` | `@opensip-cli/core` | external | environment | network | transient | error | report-failed | active | Check network connectivity and the remote endpoint. |
| `NOT_FOUND` | `@opensip-cli/core` | application | user | not-found | never | error | not-found | active | Verify the resource name and list available options. |
| `PLUGIN_INCOMPATIBLE` | `@opensip-cli/core` | application | user | compatibility | never | error | plugin-incompatible | active | Upgrade OpenSIP CLI or the tool, or trust a project-local tool via tools.trusted. |
| `PLUGIN.ERROR_CATALOG.COLLISION` | `@opensip-cli/core` | application | tool-author | conflict | never | error | plugin-incompatible | active | Two tools declare the same error code. Uninstall one, or ask its author to move the code under a namespace the tool owns. |
| `PLUGIN.ERROR_CATALOG.INVALID` | `@opensip-cli/core` | application | tool-author | validation | never | error | plugin-incompatible | active | Correct the tool |
| `PLUGIN.FINGERPRINT_STRATEGY.STAMP_FAILED` | `@opensip-cli/core` | application | tool-author | invariant | never | warning | success | active | The tool |
| `PLUGIN.SCOPE_CONTRIBUTION.COLLISION` | `@opensip-cli/core` | application | tool-author | conflict | never | error | plugin-incompatible | active | Rename the scope contribution; a tool may not overwrite a key the host or another tool already owns. |
| `PLUGIN.SCOPE_CONTRIBUTION.FORBIDDEN_KEY` | `@opensip-cli/core` | application | tool-author | security | never | error | plugin-incompatible | active | Choose a scope contribution key outside the host-reserved namespace. |
| `PLUGIN.SCOPE_CONTRIBUTION.INVALID` | `@opensip-cli/core` | application | tool-author | validation | never | error | plugin-incompatible | active | Contribute scope values as plain data; see the tool contract for the shape. |
| `RESOURCE.NOT_FOUND.RECIPE` | `@opensip-cli/fitness` | application | user | not-found | never | error | not-found | active | Run opensip fit recipes to list available recipes. |
| `SIMULATION.SCENARIO.ABORTED` | `@opensip-cli/simulation` | application | user | cancelled | never | error | cancelled | active | Scenario was cancelled. Re-run if the work is still needed. |
| `SYSTEM_ERROR` | `@opensip-cli/core` | application | tool-author | invariant | never | error | runtime | active | Retry once; if it persists, capture the run id and report a bug. |
| `SYSTEM.CAPABILITY.REGISTRAR_NOT_WIRED` | `@opensip-cli/core` | application | tool-author | invariant | never | error | runtime | active | The tool that declares this capability domain never wired its registrar. Report it to the tool author with the run id. |
| `SYSTEM.FILE.TOO_LARGE` | `@opensip-cli/core` | application | user | resource | never | error | configuration | active | The named file is larger than opensip will read. Split it, or exclude it from the analyzed target set. |
| `SYSTEM.FITNESS.SESSION_IN_PROGRESS` | `@opensip-cli/fitness` | application | tool-author | conflict | never | error | runtime | active | Wait for the active fitness session to finish or abort it. |
| `SYSTEM.IMPACT.INDEX_GENERATION_MISMATCH` | `@opensip-cli/core` | application | tool-author | invariant | never | error | runtime | active | The impact index does not match the graph catalog generation. Rebuild the graph and retry. |
| `SYSTEM.PLUGINS.ENTRY_ESCAPES_PACKAGE` | `@opensip-cli/core` | application | tool-author | security | never | error | plugin-incompatible | active | Point the pack |
| `SYSTEM.PLUGINS.FS_PROBE_FAILED` | `@opensip-cli/core` | infrastructure | environment | I/O | caller-policy | warning | runtime | active | A plugin discovery path could not be read, so some plugins may be missing from this run. Check the reported errno and the permissions on the named directory. |
| `SYSTEM.PLUGINS.REQUIRED_PACK_LOAD_FAILED` | `@opensip-cli/core` | application | tool-author | compatibility | never | error | plugin-incompatible | active | A required pack has no readable entry point. Reinstall the package, or remove it from the plugins list. |
| `SYSTEM.RUNTIME_COORDINATION.CAS_MISMATCH` | `@opensip-cli/core` | infrastructure | environment | conflict | transient | error | runtime | active | The record changed while it was being updated. Re-read the current state and retry the operation. |
| `SYSTEM.RUNTIME_COORDINATION.EXISTS` | `@opensip-cli/core` | infrastructure | environment | conflict | never | error | runtime | active | The runtime coordination record already exists. Read the existing record instead of creating it. |
| `SYSTEM.RUNTIME_COORDINATION.INVALID_KEY` | `@opensip-cli/core` | application | tool-author | validation | never | error | runtime | active | Supply a runtime coordination key that matches the documented key grammar. |
| `SYSTEM.RUNTIME_LEASE.AUTHORITY_LOST` | `@opensip-cli/core` | application | environment | integrity | transient | error | runtime | active | The exclusive lease was lost while recovery was running. Re-run; the operation made no partial change. |
| `SYSTEM.RUNTIME_LEASE.AUTHORITY_SCOPE` | `@opensip-cli/core` | application | tool-author | permission | never | error | runtime | active | This lease handle does not carry authority for the requested operation. Acquire the correct authority instead of widening this one. |
| `SYSTEM.RUNTIME_LEASE.CANCELLED` | `@opensip-cli/core` | application | user | cancelled | never | error | cancelled | active | Lease acquisition was cancelled. Re-run if the work is still needed. |
| `SYSTEM.RUNTIME_LEASE.DUPLICATE_WRITER` | `@opensip-cli/core` | application | tool-author | invariant | never | error | runtime | active | Enqueue at most one runtime writer request per owner token. |
| `SYSTEM.RUNTIME_LEASE.EMPTY_ACCESS` | `@opensip-cli/core` | application | tool-author | validation | never | error | runtime | active | Name at least one shared dimension when acquiring a runtime access lease. |
| `SYSTEM.RUNTIME_LEASE.EXCLUSIVE_UPGRADE` | `@opensip-cli/core` | application | tool-author | invariant | never | error | runtime | active | Acquire an exclusive runtime lease up front; a shared lease cannot be upgraded in place. |
| `SYSTEM.RUNTIME_LEASE.INVALID_OWNER` | `@opensip-cli/core` | application | tool-author | validation | never | error | runtime | active | Supply a runtime lease owner token that matches the documented grammar. |
| `SYSTEM.RUNTIME_LEASE.INVALID_POLICY` | `@opensip-cli/core` | application | user | validation | never | error | configuration | active | Set the named runtime lease policy value to a positive number of milliseconds within the supported range. |
| `SYSTEM.RUNTIME_LEASE.OWNER_MISMATCH` | `@opensip-cli/core` | application | tool-author | conflict | never | error | runtime | active | This runtime lease belongs to another process or project and cannot be modified from here. |
| `SYSTEM.RUNTIME_LEASE.REQUEST_LOST` | `@opensip-cli/core` | infrastructure | environment | integrity | transient | error | runtime | active | The runtime writer request disappeared during acquisition. Re-run; if it repeats, check whether the runtime directory is being cleaned externally. |
| `SYSTEM.SCOPE.CAPABILITIES_MISSING` | `@opensip-cli/core` | application | tool-author | invariant | never | error | runtime | active | The RunScope was constructed without capabilities. Capture the run id and report a bug. |
| `SYSTEM.SCOPE.NOT_ENTERED` | `@opensip-cli/core` | application | tool-author | invariant | never | error | runtime | active | This code path requires an entered RunScope. Capture the run id and report a bug. |
| `SYSTEM.TREE_SITTER.INIT_FAILED` | `@opensip-cli/tree-sitter` | infrastructure | environment | I/O | never | error | runtime | active | The tree-sitter runtime could not be initialised. Reinstall opensip-cli; if it persists, report the run id and the named grammar. |
| `SYSTEM.TREE_SITTER.NOT_INITIALIZED` | `@opensip-cli/tree-sitter` | application | tool-author | invariant | never | error | runtime | active | Initialise the tree-sitter runtime before parsing. Capture the run id and report a bug. |
| `SYSTEM.WORKER.SPAWN_FAILED` | `@opensip-cli/core` | infrastructure | environment | resource | caller-policy | error | runtime | active | A worker process could not be started. Check the reported errno, process limits, and available memory, then retry. |
| `TIMEOUT` | `@opensip-cli/core` | infrastructure | environment | timeout | caller-policy | error | runtime | active | Increase the deadline or reduce workload; check for hung dependencies. |
| `TIMEOUT.RUNTIME_COORDINATION.MUTEX` | `@opensip-cli/core` | infrastructure | environment | timeout | transient | error | runtime | active | Another opensip run holds the coordination mutex. Wait for it to finish and re-run; stop long-lived processes such as `opensip mcp` if it persists. |
| `TIMEOUT.RUNTIME_LEASE.ACCESS_COMPOSITE` | `@opensip-cli/core` | infrastructure | environment | timeout | transient | error | runtime | active | Timed out assembling the composite runtime access lease. Wait for concurrent runs to finish and retry. |
| `TIMEOUT.RUNTIME_LEASE.EXCLUSIVE` | `@opensip-cli/core` | infrastructure | environment | timeout | transient | error | runtime | active | Timed out waiting for the exclusive runtime lease. Stop or reconnect long-lived OpenSIP processes (including `opensip mcp`) and retry. |
| `TIMEOUT.RUNTIME_LEASE.GLOBAL_MAINTENANCE` | `@opensip-cli/core` | infrastructure | environment | timeout | transient | error | runtime | active | Timed out waiting for global runtime maintenance. Stop or reconnect long-lived OpenSIP processes (including `opensip mcp`) and retry. |
| `TIMEOUT.RUNTIME_LEASE.READ` | `@opensip-cli/core` | infrastructure | environment | timeout | transient | error | runtime | active | Timed out waiting to read runtime state. Another opensip run is holding it; wait and re-run. |
| `TIMEOUT.RUNTIME_LEASE.USER_STATE_READ` | `@opensip-cli/core` | infrastructure | environment | timeout | transient | error | runtime | active | Timed out reading user-state runtime data. Another opensip run is holding it; wait and re-run. |
| `UNKNOWN_FAILURE` | `@opensip-cli/core` | application | unknown | invariant | never | fatal | fatal | active | Capture the run id and operator detail; do not retry blindly. |
| `UNKNOWN_LIVE_VIEW` | `@opensip-cli/core` | application | tool-author | not-found | never | error | runtime | active | Use a registered live view key for this tool. |
| `VALIDATION_ERROR` | `@opensip-cli/core` | application | user | validation | never | error | configuration | active | Fix the invalid input, flag, or configuration value and retry. |
| `VALIDATION.CODEBASE.CONFIG_IDENTITY_UNENCODABLE` | `@opensip-cli/codebase` | application | user | validation | never | error | configuration | active | Remove the circular reference or non-JSON (bigint) value from the project configuration document, then re-run. |
| `VALIDATION.CODEBASE.INVENTORY_INPUT_INVALID` | `@opensip-cli/codebase` | application | tool-author | validation | never | error | runtime | active | Correct the named buildProjectInventory input: bounds must be positive finite numbers, and `signal` must be a real AbortSignal. Omit a bound to accept the built-in maximum. |
| `VALIDATION.COMMAND_INVENTORY.INCOMPLETE_WITHOUT_REASON` | `@opensip-cli/core` | application | tool-author | validation | never | error | plugin-incompatible | active | Supply at least one reason code whenever a runtime command inventory reports incomplete or partial coverage. |
| `VALIDATION.COMMAND_INVENTORY.PACKAGE_IDENTITY_INVALID` | `@opensip-cli/core` | application | tool-author | validation | never | error | plugin-incompatible | active | Supply a bounded, well-formed package identity on every command inventory leaf, regardless of its declared owner. |
| `VALIDATION.COMMAND_INVENTORY.PROVENANCE_SOURCE_INVALID` | `@opensip-cli/core` | application | tool-author | validation | never | error | plugin-incompatible | active | Supply a bounded provenance source name containing no control characters on every command inventory leaf. |
| `VALIDATION.COMMAND_SPEC.ACCESSOR_REJECTED` | `@opensip-cli/core` | application | tool-author | validation | never | error | plugin-incompatible | active | Declare command spec fields as plain data properties; getters and setters are rejected during admission. |
| `VALIDATION.COMMAND_SPEC.MISSING_NAME` | `@opensip-cli/core` | application | tool-author | validation | never | error | plugin-incompatible | active | Give the command spec a non-empty `name`. |
| `VALIDATION.COMMAND_SPEC.NOT_AN_OBJECT` | `@opensip-cli/core` | application | tool-author | validation | never | error | plugin-incompatible | active | Pass a plain object to defineCommand. |
| `VALIDATION.EXECUTION.INVALID_MODE` | `@opensip-cli/core` | application | tool-author | validation | never | error | plugin-incompatible | active | Set the workflow execution mode to one of the documented values. |
| `VALIDATION.RUNTIME_COORDINATION.INPUT` | `@opensip-cli/core` | application | tool-author | validation | never | error | runtime | active | Correct the named runtime coordination input and retry; this is a caller contract violation, not a project state problem. |
| `VALIDATION.TASK_CONTEXT.MANIFEST_INVALID` | `@opensip-cli/core` | application | environment | validation | never | error | runtime | active | The stored task-context manifest is not readable by this version. Re-run the tool that produced it to regenerate the evidence. |
| `VALIDATION.TOOL_IDENTITY.CONFLICT` | `@opensip-cli/core` | application | tool-author | validation | never | error | plugin-incompatible | active | Two installed tools claim the same name or alias. Uninstall one, or ask its author to rename it. |
| `VALIDATION.TOOL_IDENTITY.INVALID_NAME` | `@opensip-cli/core` | application | tool-author | validation | never | error | plugin-incompatible | active | Rename the tool identity value to kebab-case (lowercase letters, digits, and single hyphens). |
| `VALIDATION.TOOL_IDENTITY.PARENT_MISMATCH` | `@opensip-cli/core` | application | tool-author | validation | never | error | plugin-incompatible | active | Set the command parent to the tool that declares it, or move the command to the declared parent tool. |
| `VALIDATION.TOOL_IDENTITY.REQUIRED` | `@opensip-cli/core` | application | tool-author | validation | never | error | plugin-incompatible | active | Add an `identity` block to the tool definition; it is the single source of truth for the tool name and aliases. |
| `VALIDATION.TOOL_MANIFEST.DRIFT` | `@opensip-cli/core` | application | tool-author | validation | never | error | plugin-incompatible | active | Regenerate the tool manifest so it matches the runtime tool definition, then reinstall the tool. |

## See also

- [Error and resiliency model](/docs/opensip-cli/80-implementation/09-error-and-resiliency-model/)
- [ADR-0181 structured error definitions](https://github.com/opensip-ai/opensip-cli/blob/v0.8.5/docs/decisions/ADR-0181-structured-error-definitions-and-failure-envelope.md)
