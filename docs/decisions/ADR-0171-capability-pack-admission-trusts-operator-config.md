---
status: active
last_verified: 2026-07-18
owner: opensip-cli
---

# ADR-0171: Capability-pack admission trusts operator config, not the analyzed repo

```yaml
id: ADR-0171
title: Capability-pack admission trusts operator config, not the analyzed repo
date: 2026-07-18
status: active
supersedes: [ADR-0128]
superseded_by: null
related: [ADR-0081, ADR-0126, ADR-0138, ADR-0157]
tags: [plugins, capability-packs, trust-policy, security, config]
enforcement: mechanizable
enforced-by: ['local:cli-realpath-validation', 'script:capability-admission-adversarial-tests']
enforcement-reason: >
  The trust-direction policy itself ("this config SOURCE is untrusted") is not
  expressible by static analysis — it is guarded by the adversarial regression
  suite (script origin): packages/cli/src/__tests__/load-tool-capabilities.test.ts
  (analyzed-repo-config pack denied by default; provenance shadowing denied;
  grant admits), the fit-acceptance E2E operator-ceremony flow, and
  packages/cli/src/bootstrap/__tests__/capability-worker-guards.test.ts (the
  hardened advisory guard fires its diagnostic on undeclared fetch and
  out-of-root unlink). Realpath containment is the mechanical half, enforced by
  the pre-existing project-local dogfood check local:cli-realpath-validation.
```

## Decision

Capability-pack admission is the **enforced security boundary** for external
capability packs, and it trusts exactly one surface: the **user-level
global-config trust list** (`policy.trustedCapabilityPacks` on
`~/.opensip-cli/config.yml`), managed by the operator ceremony
`opensip policy trust <pack>` / `opensip policy untrust <pack>`.

1. A `plugins.<domain>` entry in the **analyzed repo's own project config** is
   discovery/selection input only — it never confers trust. Under the previous
   rule (`explicitlyConfigured ⇒ admit`), a target repo could nominate
   executable packs, inverting the trust direction for a tool whose job is
   analyzing code it does not trust.
2. Each grant binds the pack's **exact id to the provenance identity** (the
   `opensipTools` manifest hash) resolved at grant time. Packs resolve from the
   analyzed repo's `node_modules`, so a bare trusted *name* is shadowable by
   malicious code; admission requires id **and** provenance to match. A grant
   whose provenance no longer matches the resolved pack is denied with explicit
   guidance to re-verify and re-grant.
3. Unverified external packs **default to deny on load** (matching strict-mode
   behavior); a trust block appearing in the analyzed repo's project config is a
   **hard schema error** from the strict composer (the field exists only on the
   user-tier schema). The absent field reads as `deny` — the forward-compatible
   pre-feature default. The `OPENSIP_CLI_ALLOW_CAPABILITY_PACKS` env allowlist
   is **removed**. Denials and grant/revoke ceremonies record on the host
   trust-audit plane.
4. The capability-worker guard is **sharpened-advisory defense-in-depth**, not
   containment: the denylist gaps are filled (rm/unlink/rename/mkdir/chmod/
   createWriteStream/copyFile/truncate + fs/promises peers; global fetch,
   http2, dgram), its diagnostic states it is advisory, and filesystem
   containment resolves through realpath `isPathInside` (a missing leaf is
   checked at its deepest existing ancestor; unresolvable paths fail closed).

## Alternatives considered

- **`--allow` CLI flag as the trust surface** — rejected: the flag migrates
  into the analyzed repo's own `package.json` scripts and CI yml, re-opening
  the same trust inversion through a different door.
- **Env-var allowlist as the trust surface** — rejected: repo-committed
  workflow files and direnv set env for a direct `opensip` invocation, and the
  CLI cannot distinguish protected-settings env from repo-authored env. Only
  filesystem placement outside the repo is out-of-repo *by construction*.
- **Fail-closed allowlist worker guard** — rejected: in-process monkey-patching
  cannot be made sound in Node against malicious code in the same isolate
  (fresh `import('node:fs')` specifier variants, `Reflect` restoration,
  `worker_threads`, `vm`, unpatched child processes all recover original
  primitives; Node documents no in-process security boundary), and every
  Node-release fs-surface addition the allowlist missed would *silently* reopen
  the hole — recreating the false-containment defect class this decision
  eliminates. True containment is deferred to the process-level
  plugin-isolation roadmap (its own future ADR).

## Consequences

- The new-pack workflow gains one explicit operator ceremony: `opensip policy
  trust <pack>` after installing it (CI runners perform the same ceremony in
  their workflow — the workflow file IS the operator there). Grants are
  durable, revocable, and auditable (`policy status` lists them; denials cite
  the missing/mismatched grant).
- **Boundary statement:** this defends direct `opensip` invocations against
  untrusted repos. Repo-authored automation (the repo's own scripts and
  workflows) is already arbitrary code execution and sits outside this
  boundary.
- ADR-0128's resource-isolation framing claimed containment the guard cannot
  deliver; it is superseded **unconditionally**. Its project-local execution
  check (`local:no-host-external-capability-pack-execution`) remains valid and
  in force — worker isolation still applies to admitted packs; what changed is
  the honesty of the claim: isolation is defense-in-depth, admission is the
  boundary.
- The trust decision is a **config-plane** concern: no datastore table, no
  `tool_state` key, no migration.
