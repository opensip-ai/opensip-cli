---
status: active
last_verified: 2026-06-28
owner: opensip-cli
---

# ADR-0092: external adapter network/auth declaration and trust bar

```yaml
id: ADR-0092
title: external adapter network/auth declaration and trust bar
date: 2026-06-28
status: active
supersedes: []
superseded_by: null
related: [ADR-0081, ADR-0061, ADR-0087, ADR-0068, ADR-0011]
tags: [tools, adapters, trust, security, supply-chain, capabilities]
enforcement: not-mechanizable
enforcement-reason: >
  The headline decision — the security bar for listing an adapter as
  "recommended" — is a human judgment (a security review), so it is
  not-mechanizable; a check cannot assert "this code was reviewed." Two
  sub-invariants ARE mechanized: the `network`/`requires` declaration is
  manifest data validated at load (the ADR-0081 `requires` validation +
  ADR-0074 manifest contract check), and the no-raw-artifact-egress
  confidentiality rule is enforced by the negative secret-egress E2E test
  shared with ADR-0091. See the Fitness check section.
```

**Decision:** Every external adapter declares a `network` posture —
`'local-only' | 'networked' | 'auth-required'` — which the host **displays**
(`doctor`, `tools list`) and **forward-maps** onto the capability manifest's
`opensipTools.requires`: **all** adapters emit `subprocess` + `filesystem`
(they `execFile` a binary and read/write the project + artifact store), and
`network` is added **only** for a `networked`/`auth-required` posture. The
declaration is **honest labeling, not a sandbox** — capability enforcement of
`requires` is **shelved** (ADR-0087: plan 03's Phase-0 spike found no portable,
bypass-resistant network-capability mechanism, so the public untrusted ecosystem
stays closed and external tools remain trusted/private extensions with fault
isolation only), consistent with ADR-0081/ADR-0061. An adapter is listed
as **recommended** only after a security-review bar: first-party adapters take a
fast-path (opensip.ai-authored, reviewed in-repo); third-party adapters get **no
enforcement gate** — consumption-side verification stays policy-only (ADR-0068)
and recommended-listing is a human review. Independently, **no raw scanner
artifact is ever egressed** — only normalized `Signal`s leave the process.

**Alternatives:**

- **Omit a `network` field; infer posture from behavior** — rejected; posture is a
  reviewable manifest fact the operator and `doctor` should see *before* a run, and
  it is what forward-maps onto `requires`. Inference would be invisible at install
  and unverifiable at review time.
- **Emit only `network` in `requires`** (the spec's framing) — rejected as
  dishonest; every adapter forks a subprocess and touches the filesystem regardless
  of network posture. `requires` must reflect that (`subprocess` + `filesystem`
  always), with `network` added only when the scanner actually reaches the network
  (Trivy's DB pull, a future auth-token API). Risk R9.
- **Enforce `requires` now as a capability sandbox** — rejected; no capability
  sandbox exists (ADR-0081 made the same call for capability packs, and ADR-0087
  shelved it: Node `--permission` blocks fs/child/worker but **not** raw `node:net`,
  proxy env is advisory, and `sandbox-exec` is deprecated/non-portable). Implying
  enforcement would mislead. `requires` is a declaration; a bypass-resistant network
  mechanism must be proven by a future unshelving ADR before it can be enforced.
- **Auto-recommend any installable adapter** — rejected; "recommended" is a trust
  signal. A first-party fast-path plus a third-party human-review security bar keeps
  the recommended set reviewed without blocking installation of unlisted adapters.
- **Allow raw scanner reports into the cloud egress payload** — rejected
  (confidentiality); secret-scanner reports contain live credentials, and dep/IaC
  reports contain customer source paths. Raw artifacts stay `0600` in gitignored
  `.runtime` (ADR-0091); only normalized, redacted `Signal`s are delivered.

**Rationale:** ADR-0061 keeps the public untrusted ecosystem gated because
extension surfaces have different trust tiers, and ADR-0081 already established the
pattern that resource declarations are **manifest facts for review and provenance,
not enforced permissions** in this epoch. External adapters slot directly into that
posture: a `network` declaration that forward-maps to `requires` gives reviewers
and operators an honest, machine-readable surface today. Capability enforcement is
**shelved** (ADR-0087), so the field stays review/provenance-only until a future
unshelving ADR proves a network mechanism — at which point it becomes enforceable
with no contract change. The MVP's three
first-party adapters are `local-only`/`networked` (gitleaks + OSV are offline;
Trivy pulls a vuln DB), all `subprocess` + `filesystem`, none `auth-required`. The
no-egress rule is the one invariant that cannot wait for 03: it is a confidentiality
guarantee a secret scanner must carry from day one.

**Consequences:**

- **`network` is a required adapter declaration**, surfaced in the
  `AdapterDoctorReport` (ADR-0091) and `tools list`, and forward-mapped to
  `opensipTools.requires` (`subprocess` + `filesystem` always; `network` when
  `networked`/`auth-required`).
- **`requires` stays declaration-only.** Capability enforcement is shelved
  (ADR-0087 — no bypass-resistant network mechanism was proven); the field is a
  reviewed, hash-covered manifest fact (the ADR-0081 normalization) until a future
  unshelving ADR.
- **Recommended-listing bar:** first-party adapters fast-path through in-repo
  security review; third-party adapters get **no enforcement gate** —
  consumption-side verification stays policy-only (ADR-0068) and listing is a human
  review. Installation of a non-recommended adapter remains possible (deny-by-default
  trust opt-in, ADR-0054/0061) — listing is the trust signal, not the gate to install.
- **`auth-required` posture** (no MVP adapter uses it) implies credential handling
  must follow ADR-0071 (no project-file API keys; env/`--api-key`/user config only)
  — recorded so a future auth-bearing adapter inherits the policy.
- **No-egress confidentiality rule:** the cloud egress sink and any `deliverSignals`
  payload carry **only** normalized `Signal`s (ADR-0011) — never raw artifact bytes,
  never the matched secret. This is the shared guarantee with ADR-0091.

**Fitness check:** every structural invariant this ADR introduces is paired with
its enforcement:

| Invariant | Evaluation | Enforcement |
|-----------|-----------|-------------|
| Recommended-listing security bar (an adapter is listed as recommended only after review) | **No check warranted** | **Not mechanizable** — a security review is a human judgment; no fitness check / depcruise rule can assert "this code was reviewed." The bar is a process gate (first-party fast-path; third-party human review, consumption-side verification policy-only per ADR-0068), recorded here as policy. |
| `network` posture is declared and forward-mapped onto `requires` (`subprocess`+`filesystem` always; `network` only for networked/auth) | **No new check** | Manifest data validated at load — the ADR-0081 `requires` normalization/validation + the ADR-0074 manifest contract check (mirrors ADR-0081/0082: invalid state is manifest data, not a repository call shape). |
| `requires` is declaration-only (no capability sandbox) | **No check warranted** | Policy boundary inherited from ADR-0081/ADR-0061; capability enforcement is shelved (ADR-0087). A check would imply an enforcement that does not exist. |
| No raw scanner artifact (or matched secret) is egressed — only normalized `Signal`s leave the process | **Check warranted** | The NEW negative secret-egress E2E test (shared with ADR-0091): asserts the `deliverSignals` / cloud-egress payload contains only normalized `Signal`s, no `Secret`/`Match` substring and no raw artifact bytes. |
| `auth-required` adapters follow ADR-0071 credential handling | **No new check** | Existing credential-handling policy + its checks (ADR-0071); no MVP adapter exercises this, recorded for forward adapters. |

**Related specs / ADRs:** implemented by `docs/plans/ready/04-external-tool-adapters/`.
Related: [ADR-0081](ADR-0081-capability-pack-trust-and-resource-declarations.md)
(the deny-by-default + declaration-only-`requires` posture this extends to
adapters), [ADR-0061](ADR-0061-tool-platform-launch-posture-and-extension-trust-tiers.md)
(the launch posture and trust tiers; public ecosystem stays gated),
[ADR-0087](ADR-0087-public-ecosystem-readiness-shelved.md) (the plan-03 outcome:
public untrusted ecosystem **shelved**, capability/network enforcement deferred
indefinitely pending a proven mechanism), [ADR-0068](ADR-0068-consumption-side-verification-policy.md)
(consumption-side verification stays policy-only), and
[ADR-0011](ADR-0011-signal-output-currency-formatter-sink.md) (the `Signal`
currency that is the *only* thing egressed). The substrate/contract is
[ADR-0090](ADR-0090-external-tool-adapter-substrate.md); ingestion + the artifact
store + secret redaction are
[ADR-0091](ADR-0091-external-scanner-finding-ingestion.md).
</content>
