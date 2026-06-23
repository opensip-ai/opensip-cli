---
status: active
last_verified: 2026-06-23
owner: opensip-cli
---

# ADR-0059: Tool Identity Single Source

```yaml
id: ADR-0059
title: Tool Identity Single Source
date: 2026-06-23
status: active
supersedes: []
superseded_by: null
related: [ADR-0048, ADR-0054]
tags: [tools, cli, plugins, identity]
enforcement: mechanizable
enforcement-reason: >
  The `tool-identity-single-source` fitness check verifies first-party tool
  declarations, while the static manifest loader, runtime tool validator, and
  identity index reject missing, drifting, or conflicting identities during
  plugin admission.
```

**Decision:** Every Tool declares one required `identity` block. The host derives
the runtime human name, primary command and aliases, config namespace, plugin
layout key, session replay tool key, and static manifest identity from that block;
legacy inference and fallback synthesis are not valid admission paths.

**Alternatives:** (a) Keep `metadata.name`, primary command, config namespace, and
layout keys separate with more drift checks - rejected because it preserves the
same multi-literal authoring burden. (b) Infer static identity from the first
command or manifest `id` - rejected because static manifests would keep a hidden
second source of truth. (c) Use the package name as the identity - rejected because
package names are distribution coordinates, not user-facing CLI/config vocabulary.

**Rationale:** ADR-0048 made durable UUID identity explicit, but the author-facing
tool name still leaked across unrelated surfaces. A single declaration keeps
canonical CLI naming, aliases, config ownership, plugin layout, session replay,
and manifest admission coherent before the host mounts or executes a tool. It also
fits ADR-0054's fault boundary: an external tool must carry enough static identity
to be admitted without importing code or guessing command names.

**Consequences:** Static tool manifests must declare `identity` and match their
manifest `id`. Runtime exports without identity are rejected. Identity collisions
across registered tool names, aliases, layout keys, plugin layout domains, and
session replay keys are hard errors instead of last-write-wins overwrites.
Config descriptors use the canonical identity name as namespace. Public examples
must use `definePrimaryCommand`, `defineNestedCommand`, and `defineTool` so authors
write names once.

**Related specs / ADRs:** `docs/plans/specs/tool-identity-single-source.md`,
ADR-0048 (stable UUID identity), ADR-0054 (tool fault-isolation boundary).
