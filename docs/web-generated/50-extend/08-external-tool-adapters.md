---
status: current
last_verified: 2026-06-28
release: v0.2.2
title: "External tool adapters"
audience: [plugin-authors]
purpose: "Wrap a local CLI scanner (gitleaks/osv-scanner/trivy/…) as a first-class OpenSIP Tool with defineExternalToolAdapter — a descriptor plus a parser, not a from-scratch Tool."
source-files:
  - packages/external-tool-adapter/src/define-external-tool-adapter.ts
  - packages/external-tool-adapter/src/types.ts
  - packages/external-tool-adapter/src/ingest-sarif.ts
  - packages/external-tool-adapter/src/doctor-command.ts
  - packages/external-tool-adapter/src/redact.ts
  - packages/tool-gitleaks/src/tool.ts
  - packages/tool-gitleaks/src/parse-gitleaks-json.ts
  - packages/tool-osv-scanner/src/tool.ts
  - packages/tool-trivy/src/tool.ts
related-docs:
  - ./06-full-tool-plugins.md
  - ./07-command-taxonomy.md
  - ../70-reference/01-cli-commands.md
  - ../70-reference/12-tools-command.md
  - ../70-reference/10-environment-variables.md
  - ../../decisions/ADR-0090-external-tool-adapter-substrate.md
  - ../../decisions/ADR-0091-external-scanner-finding-ingestion.md
  - ../../decisions/ADR-0092-external-adapter-network-auth-trust.md
---
# External tool adapters

An **External Tool Adapter** wraps a user-installed CLI scanner — `gitleaks`,
`osv-scanner`, `trivy`, or your own — as an ordinary OpenSIP `Tool`. The scanner
runs as a subprocess; its native output (JSON or SARIF) is normalized to the
platform's `Signal` currency, persisted, gated by the baseline ratchet, and
egressed exactly like a `fit` or `graph` finding. The author writes a **descriptor
plus a parser**, not a from-scratch Tool: the substrate
[`@opensip-cli/external-tool-adapter`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/packages/external-tool-adapter)
owns binary resolution, the run loop, the shared SARIF/JSON ingest, the
`doctor`/`version` commands, secret redaction, provenance, and the gate.

The three MVP adapters are the worked examples and the precedent for any new one:

| Adapter | Wraps | Scans | Native output | Posture |
|---------|-------|-------|---------------|---------|
| [`@opensip-cli/tool-gitleaks`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/packages/tool-gitleaks) | `gitleaks` | Committed secrets in the working tree | JSON (`parse`) | `local-only` |
| [`@opensip-cli/tool-osv-scanner`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/packages/tool-osv-scanner) | `osv-scanner` | Dependency vulnerabilities | JSON (`parse`) | `local-only` |
| [`@opensip-cli/tool-trivy`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/packages/tool-trivy) | `trivy` | Vulnerabilities + misconfigurations | SARIF (shared `ingestSarif`) | `local-only` |

Adapters are **opt-in and never bundled** — the core CLI stays scanner-agnostic.
A user installs one with `opensip tools install`, then trusts it (see
[Trust and execution model](#trust-and-execution-model)). The full user-facing
flow is in the [CLI command reference](/docs/opensip-cli/70-reference/01-cli-commands/#external-tool-adapters-opt-in).

This shape is decided in [ADR-0090](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/docs/decisions/ADR-0090-external-tool-adapter-substrate.md)
(the substrate + worker dispatch), [ADR-0091](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/docs/decisions/ADR-0091-external-scanner-finding-ingestion.md)
(ingestion, artifacts, exit modeling), and [ADR-0092](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/docs/decisions/ADR-0092-external-adapter-network-auth-trust.md)
(network posture + the no-egress confidentiality rule).

## When to write an adapter

Reach for an adapter when you already have a **CLI scanner that emits JSON or
SARIF** and you want its findings to land in OpenSIP's currency: one
`SignalEnvelope`, the SQLite session store, the `--gate-save`/`--gate-compare`
ratchet, SARIF/cloud egress, and the HTML report. If instead you want to author
analysis logic *in TypeScript* (no external binary), write a
[full Tool plugin](/docs/opensip-cli/50-extend/06-full-tool-plugins/) or a
[check pack](/docs/opensip-cli/50-extend/03-publishable-packs/) — an adapter is specifically the "wrap a
binary" path.

## The mental model

An adapter is an **ordinary `Tool`** — `defineExternalToolAdapter(spec)` returns
`defineTool(...)`, so there is no new plugin kind. What the substrate owns versus
what you write:

| The substrate owns | You write |
|--------------------|-----------|
| Binary resolution (config/env → `PATH`) | The identity + binary declaration |
| The run loop (resolve → `execFile` → read → persist → parse → normalize → emit → deliver) | The `scan` command's `args(ctx)` |
| The auto-added `doctor` + `version` commands | A JSON `parse(raw, ctx)` (SARIF adapters omit it) |
| The shared `ingestSarif` + severity mapping | The native-severity → four-bucket map (for JSON) |
| Secret redaction helpers | The redaction *call* in a secret-scanner parser |
| Worker-side fingerprint stamping + the gate | Optional namespaced config + `network` posture |
| Provenance, artifact persistence, the `--json`/gate/`--report-to` flags | — |

The scanner binary is launched with `execFile` — **no shell** — so an adapter
never interpolates a command string. Args are an array.

## A complete worked example

Here is the gitleaks descriptor in full (the real shipped
[`packages/tool-gitleaks/src/tool.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/packages/tool-gitleaks/src/tool.ts)),
the canonical model for a JSON adapter:

```typescript
import { readPackageVersion } from '@opensip-cli/core';
import { defineExternalToolAdapter } from '@opensip-cli/external-tool-adapter';

import { parseGitleaksJson } from './parse-gitleaks-json.js';

import type { Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';

const GITLEAKS_IDENTITY: ToolIdentity = { name: 'gitleaks', aliases: ['secrets'] };

/** Build the gitleaks scan argv (no shell — args go to execFile). */
function buildScanArgs(ctx: AdapterRunContext): readonly string[] {
  return [
    'detect',
    '--no-git',
    '--source', ctx.projectRoot,
    '--report-format', 'json',
    '--report-path', ctx.artifactPath('gitleaks.json'),
  ];
}

export const tool: Tool = defineExternalToolAdapter({
  identity: GITLEAKS_IDENTITY,
  metadata: {
    id: 'cd08f737-ce8e-4813-9259-b4ffeb954268', // stable UUID (ADR-0048)
    version: readPackageVersion(import.meta.url),
    description: 'Secret scanning via Gitleaks',
    adapterPackage: '@opensip-cli/tool-gitleaks',
  },
  binary: {
    command: 'gitleaks',
    versionArgs: ['version'],
    versionParse: parseGitleaksVersion, // stdout → bare semver
    minVersion: '8.18.0',
    resolution: ['config', 'path'], // operator pin beats PATH; never fetches
    installHint:
      'Install gitleaks: https://github.com/gitleaks/gitleaks#installing (brew install gitleaks)',
  },
  network: 'local-only',
  commands: [
    {
      name: 'scan',
      description: 'Scan the project working tree for committed secrets (Gitleaks)',
      args: buildScanArgs,
      output: { kind: 'json', path: 'gitleaks.json' },
      exitCodes: { ok: [0], findings: [1], errorFrom: 2 },
      parse: parseGitleaksJson,
    },
  ],
  fingerprintStrategy: 'message-hash',
});
```

The package's `src/index.ts` barrel re-exports it as `tool` — that is the symbol
the host loads.

### The descriptor, field by field

`defineExternalToolAdapter(spec)` takes an
[`ExternalToolAdapterSpec`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/packages/external-tool-adapter/src/types.ts):

- **`identity`** — a `ToolIdentity` (`name` + optional `aliases`). `gitleaks` is
  reachable as `opensip gitleaks` **or** `opensip secrets`. The `name` is also the
  artifact-store subdir and the `binaries.<name>.path` config key.
- **`metadata.id`** — a stable UUID ([ADR-0048](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/docs/decisions/ADR-0048-tool-stable-uuid-identity.md)).
  Generate it once; it must match `package.json#opensipTools.stableId`.
- **`metadata.version`** — `readPackageVersion(import.meta.url)` reads the
  package's own version; stamped into Tool metadata and provenance.
- **`metadata.adapterPackage`** — the npm package name, stamped into every
  signal's provenance.
- **`binary`** — the wrapped-binary declaration (see [the binary story](#the-binary-story)).
- **`network`** — `'local-only' | 'networked' | 'auth-required'` (see
  [Network posture and `requires`](#network-posture-and-requires)).
- **`commands`** — one or more scanner verbs. The **first** is the primary
  (`opensip <tool>`); any others mount as nested verbs (`opensip <tool> <verb>`).
  `doctor` and `version` are added automatically — never declare them.
- **`fingerprintStrategy`** — `'message-hash'` (the adapter default) or
  `'rule-location'`. Keep `message-hash`: scanner output is line-volatile, so the
  line-shift-tolerant message hash is a better baseline id than the host
  `ruleId|file|line|col` default. It is stamped **worker-side** when the envelope
  is built; the host ratchet only reads `signal.fingerprint`.
- **`config`** — an **optional** namespaced config contribution. **Omit it** for the
  standard behaviour: the substrate claims your namespace by default (the
  `binaries.<tool>.path` operator pin + the reserved verdict-policy keys), so the
  binary pin resolves and the gate thresholds are configurable like a bundled tool.
  Supply a custom contribution only to claim **extra** keys.

### The `scan` command

Each entry of `commands` is an
[`ExternalCommandSpec`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/packages/external-tool-adapter/src/types.ts):

- **`args: (ctx) => readonly string[]`** — build the scanner argv from the
  [`AdapterRunContext`](#the-run-context). Write the scanner's native report to
  `ctx.artifactPath('<name>')` so the substrate can read and persist it.
- **`output: { kind, path? }`** — `kind` is `'json' | 'sarif' | 'stdout'`. `path`
  is the artifact basename the scanner writes to. For `'stdout'` the substrate
  captures stdout directly.
- **`exitCodes: ScannerExitModel`** — `{ ok, findings, errorFrom? }`. Separates
  "scanner found problems" (a verdict) from "scanner broke" (a fault). Defaults to
  `{ ok: [0], findings: [1], errorFrom: 2 }`. See [exit modeling](#exit-modeling).
- **`parse: (raw, ctx) => readonly Signal[]`** — native output → normalized
  signals. **Required for JSON/stdout; omitted for SARIF** (the shared
  `ingestSarif` handles it). `defineExternalToolAdapter` throws
  `ADAPTER.SPEC.MISSING_PARSE` at definition time if a non-SARIF command has no
  `parse`.

### The run context

The substrate hands `args(ctx)` and `parse(raw, ctx)` a read-only
[`AdapterRunContext`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/packages/external-tool-adapter/src/types.ts):

```typescript
interface AdapterRunContext {
  readonly tool: string;            // 'gitleaks'
  readonly adapterPackage?: string;
  readonly projectRoot: string;     // the targeting root to scan
  readonly runId: string;           // this invocation's id (the artifact run-segment)
  readonly logger: Logger;
  readonly config: Readonly<Record<string, unknown>>; // the namespaced config block
  readonly binary: ResolvedBinary;  // resolved path / layer / version
  readonly configPath?: string;
  artifactPath(name: string): string; // → .runtime/artifacts/<tool>/<runId>/<name>
}
```

It is built from the host `ToolCliContext` with **no `cli` import** (paths come
from core's `resolveProjectPaths`), so the substrate stays layer-legal.

## JSON versus SARIF

The choice is the single biggest authoring fork.

**A JSON (or stdout) adapter writes a `parse`.** It receives the native bytes
(pre-parsed JSON when available) and returns `readonly Signal[]` via
`createSignal(...)`. You own the native-severity → four-bucket mapping. The
substrate exports defensive JSON-navigation helpers (`asArray`, `asObject`,
`getString`, `getNumber`, `navigate`, `safeParseJson`) and severity helpers
(`cvssToSeverity`, `parseCvss`, `withNativeSeverity`) so a parser never throws on
malformed input — a bad element is skipped, not fatal. Gitleaks and OSV-Scanner
are JSON adapters.

**A SARIF adapter declares `output: { kind: 'sarif' }` and OMITS `parse`.** The
substrate's shared `ingestSarif` reads the SARIF 2.1.0 log. There is exactly **one**
SARIF read path in the whole codebase (the `single-sarif-ingest` dependency-cruiser
rule); an adapter must not parse SARIF itself. Trivy is the SARIF adapter.

`ingestSarif` does the **severity recovery** that a level-only inverse can't:
OpenSIP's SARIF writer collapses both `critical` **and** `high` into SARIF
`error`, so it reads `driver.rules[ruleIndex].properties["security-severity"]`
(a CVSS number) and applies FIRST/NVD v3 bands (≥9.0 critical · 7.0–8.9 high ·
4.0–6.9 medium · 0.1–3.9 low) **before** falling back to `level` (`error→high`,
never critical). A `9.8` result with `level:"error"` correctly normalizes to
`critical`.

### Normalizing to `Signal`

Every parser targets `createSignal(...)`. `SignalSeverity` has **only four
buckets** — `'critical' | 'high' | 'medium' | 'low'` (no info/unknown rung). Set
`category: 'security'`, the `code: { file, line?, column? }` location, and put the
scanner's **native** severity and any scanner-specific facts on the opaque
`metadata` bag ([ADR-0042](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/docs/decisions/ADR-0042-tool-storage-contract-and-state-store.md)).
Always preserve the raw label as `metadata.nativeSeverity` (Trivy's `CRITICAL…`,
OSV's `MODERATE`/numeric/unknown, gitleaks' `null`) so a downstream reader knows
the four-bucket value is a mapping, not the scanner's own word. `fingerprint` is
host-stamped later — never set it in a parser.

## Secret hygiene

This is a **hard confidentiality contract**, not a guideline. A secret scanner
captures the live credential. It must **never** reach `Signal.message`,
`Signal.metadata` in raw form, or any egress payload. A secret-scanner parser
redacts the matched secret to a non-reversible preview (or hash) — only that, plus
a fingerprint, ever leaves the parser. The substrate exports two helpers:

```typescript
redactSecret('AKIAIOSFODNN7EXAMPLE'); // → 'AKIA…' (first 4 chars + ellipsis; ≤4 chars → '…')
secretHash('AKIAIOSFODNN7EXAMPLE');    // → first 12 hex of SHA-256
```

The gitleaks parser
([`parse-gitleaks-json.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/packages/tool-gitleaks/src/parse-gitleaks-json.ts))
is the model: gitleaks emits `Secret` (the raw credential) **and** `Match` (the
surrounding region, which *includes* the secret). The parser stores only
`redactSecret(Secret)` as `metadata.secretPreview` and **drops `Match` entirely**:

```typescript
const secretPreview = redactSecret(getString(finding, 'Secret'));
const metadata = withNativeSeverity(
  {
    nativeFingerprint: getString(finding, 'Fingerprint') ?? null,
    entropy: getNumber(finding, 'Entropy') ?? null,
    tags: asArray(finding.Tags) ?? [],
    ...(secretPreview.length > 0 ? { secretPreview } : {}),
  },
  null, // stock gitleaks emits no severity — constant-map every secret to `high`
);
```

A negative E2E test asserts no `Secret`/`Match` substring crosses the worker→host
`deliverSignals` payload (ADR-0091/0092). The **raw** report (which does contain
the secret) is persisted `0600` in the gitignored artifact store and is never
egressed — see below.

## The binary story

The substrate resolves the scanner binary by a **layered, deterministic order,
first hit wins** — and **never fetches** a binary. A network download triggered by
a security scan would be a surprising, unsigned supply-chain side effect; a missing
binary yields a `doctor` install hint instead. The `BinarySpec`:

- **`command`** — the `PATH` lookup name (`'gitleaks'`).
- **`versionArgs`** — args that print the version (`['version']` / `['--version']`),
  used by `doctor`, `version`, and provenance.
- **`versionParse?`** — normalize the version stdout to a bare semver (the MVP
  adapters take the first semver-shaped token and strip a leading `v`). Defaults to
  `stdout.trim()`.
- **`minVersion?`** — `doctor` warns when the resolved version is below it.
- **`resolution?`** — the order, default `['config', 'path']`. `config` reads the
  operator pin from the namespaced config (`binaries.<tool>.path`) **and** the
  `OPENSIP_<TOOL>_BIN` env var; `path` is the system `PATH` lookup.
- **`envVar?`** — the pin env var, default `OPENSIP_<TOOL>_BIN` (the identity name
  uppercased, `-`→`_`; so `OPENSIP_OSV_SCANNER_BIN`, `OPENSIP_TRIVY_BIN`).
- **`installHint?`** — a platform-agnostic install hint surfaced by `doctor` when
  the binary is missing.

So resolution is: operator config pin → `OPENSIP_<TOOL>_BIN` → `PATH`. The
`OPENSIP_<TOOL>_BIN` env override always works, **and so does the config-file pin
`binaries.<tool>.path`** — every adapter **claims its config namespace by default**
(omit `config` on the spec and the substrate supplies a schema for the `binaries`
block plus the reserved verdict-policy keys), so the strict-validated config
document accepts:

```yaml
gitleaks:
  binaries:
    gitleaks:
      path: /opt/homebrew/bin/gitleaks # operator pin, beats PATH
  failOnWarnings: 1 # the reserved verdict-policy keys are configurable too
```

Declare a `config` contribution explicitly only to claim **extra** keys; doing so
opts out of the auto-generated static descriptor (its validation then defers to the
worker). What OpenSIP owns: the lookup, the version probe, the readiness verdict.
What you own: the `command` name and the install hint.

## `doctor` and `version` (auto-added)

The substrate adds a `doctor` and a `version` subcommand to **every** adapter — you
write neither. They probe the binary worker-side:

`opensip <tool> doctor` reports a plain
[`AdapterDoctorReport`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/packages/external-tool-adapter/src/doctor-command.ts)
(not a `CommandResult` variant — that union is closed): the binary (found / path /
resolution layer), the detected version vs. `minVersion`, the `network` posture,
a credential-env presence check for `auth-required` postures, the install hint
when missing, and a final `ready` boolean. Human output is text lines; `--json`
emits the structured report. **Exit `0` when ready, `2` when not** — so CI can gate
on `opensip <tool> doctor`.

`opensip <tool> version` prints the resolved binary version and path (`--json` for
the structured shape).

## The execution model

An adapter is **installed, not bundled**, so the host **never imports its
runtime**. At discovery the host registers a manifest-synthesized `Tool`; at
invocation (`opensip gitleaks …`) it **forks a worker** that re-runs CLI bootstrap,
re-discovers and imports the real runtime, runs the handler, and replays a slim
result through the host seams. Both the `scan` handler **and** the `doctor`/
`version` probes run **worker-side**. The worker is the fault-isolation boundary
([ADR-0054](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/docs/decisions/ADR-0054-tool-fault-isolation-boundary.md)) — a crashing
or hanging scanner cannot take down the host.

Consequences for an author: the run loop body executes in the worker; every
`cli.*` effect (artifact write, envelope emit, deliver, exit) is captured there and
replayed through host seams (`writeArtifact` via host RPC, the rest via the
forwarded result). You never call `cli` directly — you write a descriptor and a
parser, and the substrate drives the loop.

Both the primary `scan` and the `doctor`/`version` commands are declared
`output: 'raw-stream'` (with `rawStreamReason` `runtime-render-dispatch` and
`diagnostic-gate` respectively) because the handler owns its runtime-conditional
output; see [Command surface taxonomy](/docs/opensip-cli/50-extend/07-command-taxonomy/).

## The artifact store

The scanner's raw native report persists under
`<project>/opensip-cli/.runtime/artifacts/<tool>/<runId>/<name>` through the
host-owned `cli.writeArtifact` seam
([ADR-0080](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/docs/decisions/ADR-0080-host-owned-artifact-write-seam.md)) — adapter
code never writes `.runtime` with raw `fs`. The store is:

- **`0600`** — owner-read/write only (the host writer sets the mode; the single
  enforcement point covers every artifact).
- **gitignored** — `.runtime/` is never committed.
- **never egressed** — only normalized, redacted `Signal`s leave the process. The
  raw report stays on disk for local inspection.
- **retained** — the host keeps the most-recent run-dirs per tool and prunes the
  rest after each write, governed by the `cli.artifacts.keep` config (default
  **10**; `0` disables pruning).

The substrate composes the run-segment path (`ctx.artifactPath(name)`); the host
owns the perms and retention.

## Exit modeling

Scanners overload exit codes, so a `ScannerExitModel` separates findings from
faults per command. The frozen MVP models (ADR-0091) are the templates:

- **Gitleaks** — `{ ok: [0], findings: [1], errorFrom: 2 }`. Gitleaks **also**
  exits `1` on an internal fatal, so the substrate disambiguates by **artifact
  presence + JSON-parseability**: exit 1 + a valid report ⇒ findings; exit 1 +
  missing/garbage ⇒ fault.
- **OSV-Scanner** — `{ ok: [0, 128], findings: [1], errorFrom: 2 }`. Exit `128`
  ("no packages/lockfiles found") is a clean no-op, not a fault, so it joins `ok`.
- **Trivy** — `{ ok: [0], findings: [], errorFrom: 1 }`. Trivy is **not** passed
  `--exit-code` (which would collide a findings-1 with an error-1), so it exits `0`
  even with findings; the substrate derives findings from the parsed SARIF and
  treats any nonzero as a fault.

A `fault` raises `ADAPTER.SCAN.FAULT` (with a stderr tail) and exits non-zero; a
`findings` verdict produces a normal envelope.

## Network posture and `requires`

Every adapter declares a `network` posture (ADR-0092): `'local-only'`,
`'networked'`, or `'auth-required'`. The host **displays** it (`doctor`,
`tools list`) and the manifest generator **forward-maps** it onto the capability
manifest's `opensipTools.requires` — **derived, not hand-authored**: **all**
adapters emit `subprocess` + `filesystem` (they `execFile` a binary and read/write
the project + artifact store), and `network` is added **only** for a
`networked`/`auth-required` posture. Because the mapping is derived, flipping an
adapter's posture surfaces as a `tool-manifests --check` drift (CI fails until the
manifest is regenerated) — you can't ship a `networked` adapter that still claims
`[subprocess, filesystem]`. All three MVP adapters are `local-only` (`subprocess` +
`filesystem` only) — Trivy is `local-only` because it scans against a
**pre-populated local DB cache** with `--offline-scan`.

`requires` is **declaration-only** — honest labeling for review and
provenance, not an enforced sandbox. Capability *enforcement* is **shelved**
([ADR-0087](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/docs/decisions/ADR-0087-public-ecosystem-readiness-shelved.md): plan 03
found no portable, bypass-resistant network mechanism — Node `--permission` blocks
fs/child/worker but not raw `node:net` sockets), so external tools stay
trusted/private extensions ([ADR-0061](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/docs/decisions/ADR-0061-tool-platform-launch-posture-and-extension-trust-tiers.md)).
The field becomes enforceable with no contract change if a future ADR unshelves it.
Declare the posture honestly anyway.

## Trust and execution model

Installed tools found ambiently in `node_modules` are **deny-by-default**.
`opensip tools install @opensip-cli/tool-gitleaks` validates the package,
installs the validated bytes, and records managed trust for the selected scope:

```bash
opensip gitleaks doctor
```

This is the same surface every installed Tool plugin mounts through ([`tools`
reference](../70-reference/12-tools-command.md)); adapters add no new trust path.
`OPENSIP_CLI_ALLOW_INSTALLED_TOOLS` remains an exact-id override for manual
experiments or incident response.

## Distribution

Ship an adapter as its own publishable package, **repo-per-tool**
(`@opensip-cli/tool-<x>`), with production dependencies of exactly
`@opensip-cli/external-tool-adapter` + `@opensip-cli/core`. It is opt-in: a user
installs it explicitly with `opensip tools install`, and it is **never added to
`bundled-tools.manifest.json`**. A curated "scanner pack" is a possible later,
additive option; bundling is not.

The static `package.json#opensipTools.commands` (the `scan`/`doctor`/`version`
shells the host mounts before the worker exists) is **generated from the runtime
`commandSpecs`, not hand-authored** — `assertCommandNamesMatch` throws on drift at
install and worker import. The first-party adapters generate and drift-gate theirs
through the shared tool-manifest generator.

The **public third-party adapter ecosystem** stays gated on the platform's launch
posture (ADR-0061): the first-party MVP adapters ship because they are
opensip.ai-authored JS wrapping a user-installed subprocess and add no untrusted-JS
surface. A third-party adapter is installable today (deny-by-default trust opt-in)
but is not a *recommended* listing until it clears the consumption-side security
bar.

## Reference

- [CLI command reference — External tool adapters](/docs/opensip-cli/70-reference/01-cli-commands/#external-tool-adapters-opt-in)
- [`tools` command](/docs/opensip-cli/70-reference/12-tools-command/)
- [Environment variables](/docs/opensip-cli/70-reference/10-environment-variables/)
- [ADR-0090](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/docs/decisions/ADR-0090-external-tool-adapter-substrate.md) ·
  [ADR-0091](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/docs/decisions/ADR-0091-external-scanner-finding-ingestion.md) ·
  [ADR-0092](https://github.com/opensip-ai/opensip-cli/blob/v0.2.2/docs/decisions/ADR-0092-external-adapter-network-auth-trust.md)
</content>
</invoke>
