---
status: active
last_verified: 2026-07-02
owner: opensip-cli
---

# ADR-0115: Treat framework conventions as target-scoped project intent

```yaml
id: ADR-0115
title: Treat framework conventions as target-scoped project intent
date: 2026-07-02
status: active
supersedes: []
superseded_by: null
related: [ADR-0023, ADR-0037, ADR-0084, ADR-0095]
tags: [configuration, targeting, graph, fitness, yagni, agents]
enforcement: mechanizable
enforcement-reason: >
  The composed config schema admits only the documented convention shape; the CLI
  target builder rejects absolute and parent-traversal convention globs with
  CONFIGURATION.TARGETS.INVALID; package tests cover graph, fitness, YAGNI, agent
  catalog, and MCP consumption; dependency-cruiser preserves the config/CLI-free
  tool consumption path.
```

**Decision:** `targets.<name>.conventions` is the CLI's project-scoped place for
framework/runtime behavior that static analysis cannot infer. Tools consume it
through `RunScope.targets`, not by importing config or the CLI, and agent-facing
surfaces expose only bounded counts.

**Alternatives:**

- Put framework knowledge inside individual graph/fitness/YAGNI rules. Rejected
  because it duplicates project intent and makes each tool grow its own config
  vocabulary.
- Add tool-specific suppressions only. Rejected because conventions affect more
  than one tool: graph reachability, fitness dead-code, and YAGNI confidence all
  need the same project declaration.
- Expose raw convention patterns and expanded matches to agents. Rejected because
  agent discovery needs orientation, not a full file inventory; expanded matches
  would be noisy and could leak more project structure than necessary.

**Rationale:** Targets already define the host-owned file-set reality
(`packages/config/src/document/targeting.ts`, `packages/cli/src/bootstrap/build-targets.ts`,
ADR-0037). Framework conventions are part of that same reality: route files,
runtime-loaded config, and dynamically used exports are target-specific facts,
not generic tool preferences. Keeping the data on targets lets the host validate
paths once, then lets graph, fitness, and YAGNI consume the same declaration via
the documented `RunScope.targets` seam.

**Consequences:**

- Convention globs must be project-relative and must not contain `..` segments.
- `graph` may add `target-convention` entry points, but it does not rewrite the
  catalog or pretend static call edges exist.
- `fit` may suppress only the documented dead-file and unused-export cases; other
  Knip finding classes remain visible.
- `yagni` lowers confidence for convention-owned files before filtering rather
  than suppressing findings.
- `agent-catalog` and MCP `get_architecture` expose target convention counts only.

**Related specs / ADRs:**

- `docs/plans/specs/27-framework-convention-config.md`
- `docs/plans/ready/framework-convention-config/`
- [ADR-0023](ADR-0023-config-package-and-schema-registry.md)
- [ADR-0037](ADR-0037-generic-targeting-runtime.md)
- [ADR-0084](ADR-0084-mcp-server-surface.md)
- [ADR-0095](ADR-0095-ai-native-guardrail-platform-posture.md)
