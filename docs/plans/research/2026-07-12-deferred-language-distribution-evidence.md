# Deferred Language Distribution Evidence

**Evidence captured:** 2026-07-13 PDT (report timestamp 2026-07-14 UTC)
**Scope:** Current full-bundle distribution measurement; no deferred capability implementation
**Report schema:** 1
**Decision owner:** Repository evidence record for Thread A

## Decision

**Disposition: retain full bundle.**

The measurement is reproducible, but it does not establish material customer
pain or a defensible slim-package benefit. Language-family bytes are attribution
inside the current package graph, not removable savings, and the required
offline, skipped-init, fail-closed repair, version/ABI, and ADR design work has
not been done. The independently shipped init footer improves discovery without
weakening the closed, host-wired language substrate.

The evaluated alternatives, shipped init outcome, and reopening gates are
preserved in the
[Deferred Language Capability And Init UX Decision Record](./2026-07-13-deferred-language-capability-decision.md).

## Raw evidence identity

The authoritative raw artifact remains intentionally ignored at
`.opensip-distribution/distribution-footprint-report.json`.
The reproducible operating procedure is the contributor-facing
[Distribution Footprint Measurement](../../internal/distribution-footprint-measurement.md)
protocol.

| Field | Value |
|---|---|
| Report SHA-256 | `dbe54f4499f47051b87bafd2a7b58a4614adf43bbb39ce5301e9ea729ebd2782` |
| Artifact-set SHA-256 | `002343d8c68e8c587cf0d3dd24a22417a128b904cb6bbc2dd12fa0dd80542ca6` |
| Generated at | `2026-07-14T02:56:22.568Z` |
| Git SHA | `2ff9fb30a53465685e6a6c395498f349534d2996` |
| CLI version | `0.6.0` |
| Node / pnpm / npm | `v24.16.0` / `11.10.0` / `11.13.0` |
| Platform | `darwin arm64`, Darwin `25.5.0` |
| Mode / repeats | `offline-cache` / 20 per startup scenario |
| pnpm store | `/Users/sb/Library/pnpm/store/v11` |
| Generated lock SHA-256 | `af991efb9616a2b5334097f099b1c7a61705ec146f2e49ff3b9e296c410914bb` |

The evidence was produced from a fresh build of the exact committed SHA and a
new canonical set of 57 publishable release tarballs:

```bash
pnpm build
mkdir -p .opensip-distribution/tarballs-2ff9fb30
while IFS= read -r package; do
  pnpm --filter "$package" pack \
    --pack-destination "$PWD/.opensip-distribution/tarballs-2ff9fb30"
done < <(node scripts/release-package-order.mjs --print pack)

pnpm store path
pnpm distribution:measure -- \
  --dir .opensip-distribution/tarballs-2ff9fb30 \
  --expected-version 0.6.0 \
  --mode offline-cache \
  --store-dir /Users/sb/Library/pnpm/store/v11 \
  --repeats 20 \
  --out .opensip-distribution/distribution-footprint-report.json

shasum -a 256 \
  .opensip-distribution/distribution-footprint-report.json
```

No cold-registry run was performed because outbound registry access was not
needed for this decision and was not separately authorized.

## Observed distribution footprint

| Metric | Observed value |
|---|---:|
| Complete 57-tarball release set | 4,547,950 bytes (4.34 MiB) |
| Installed CLI closure tarballs | 4,381,677 bytes (4.18 MiB) |
| Release-set rows not in installed CLI closure | 166,273 bytes (162.4 KiB) |
| Physical installed `node_modules` | 122,901,687 bytes (117.21 MiB) |
| Installed files / entries | 22,924 / 25,096 |
| Installed dependency identities | 289 |
| Offline install duration | 1,955 ms |
| Offline install maximum observed RSS | 640,057,344 bytes (610.41 MiB) |

The complete release set is not a customer transfer estimate: it includes
opt-in `tool-*` packages that are not in the default CLI closure. The installed
closure compressed total is the closer transfer proxy. The much larger physical
tree includes third-party dependencies, native output, metadata, and unpacked
first-party files.

## Fresh-process startup

Each row contains 20 fresh processes. The runner first proved the generated
installed bin contract with `pnpm exec opensip --version`; the recorded samples
then invoked Node plus the declared installed JavaScript target so pnpm and
platform-shim overhead did not contaminate startup timing.

| Scenario | Median | Nearest-rank p95 | Range |
|---|---:|---:|---:|
| `opensip --version` | 653.5 ms | 671 ms | 628–677 ms |
| `opensip --help` | 804.5 ms | 861 ms | 781–1,372 ms |
| `opensip init --help` | 795.5 ms | 807 ms | 777–812 ms |

The first `--help` sample was a 1,372 ms outlier. It remains in the raw sample
set and does not change the nearest-rank p95 because 19 of 20 samples were at or
below 861 ms.

## Language-family attribution

These rows include only each language's named `lang-*`, language-specific
`checks-*`, and available `graph-*` packages. Universal checks, graph substrate,
the CLI host, and third-party/shared dependencies are deliberately excluded.

| Language | Packages | Compressed attribution | Logical unpacked attribution |
|---|---:|---:|---:|
| TypeScript | 3 | 373,297 bytes (364.5 KiB) | 1,555,359 bytes (1.48 MiB) |
| Rust | 3 | 176,806 bytes (172.7 KiB) | 1,287,979 bytes (1.23 MiB) |
| Python | 3 | 124,428 bytes (121.5 KiB) | 629,439 bytes (0.60 MiB) |
| Go | 3 | 90,370 bytes (88.3 KiB) | 368,912 bytes (0.35 MiB) |
| Java | 3 | 107,122 bytes (104.6 KiB) | 583,715 bytes (0.56 MiB) |
| C/C++ | 2 | 19,617 bytes (19.2 KiB) | 56,528 bytes (0.05 MiB) |
| **Total attributable** | **17** | **891,640 bytes (0.85 MiB)** | **4,481,932 bytes (4.27 MiB)** |

The compressed attribution is 20.35% of the current installed OpenSIP closure
tarballs, but that percentage is not a projected size reduction. Shared
dependencies cannot be subtracted, the host currently wires all language
adapters, and no candidate slim package was built or measured.

## Failure and offline probes

The canonical run completed with zero loopback sentinel connections. Additional
negative probes used the same committed runner:

| Probe | Result |
|---|---|
| Only the CLI tarball supplied | Exit 1; no report written |
| Complete tarballs with an empty pnpm content store | Exit 1; no report written |
| `registry-cold` without `--allow-registry` | Exit 1; no report written |

An additional macOS-only smoke ran one repetition under:

```bash
sandbox-exec -p '(version 1) (allow default) (deny network-outbound)' \
  pnpm distribution:measure -- \
  --dir .opensip-distribution/tarballs-2ff9fb30 \
  --expected-version 0.6.0 \
  --mode offline-cache \
  --store-dir /Users/sb/Library/pnpm/store/v11 \
  --repeats 1 \
  --out .opensip-distribution/distribution-footprint-sandbox-smoke.json
```

That OS-denied-network smoke also completed with 122,901,687 installed bytes and
289 dependencies. It is corroborating platform-specific evidence, not part of
the portable report contract.

## Customer evidence

No named customer evidence was available that install footprint or startup is a
top-three problem. The measurements establish a baseline, not customer pain.
Humans and agents benefit more immediately from deterministic availability and
the new structured init recommendations than from an unproven packaging split.

## Graduation-gate assessment

| Gate | Assessment |
|---|---|
| Current reproducible report | Met by the hash-identified schema-v1 artifact |
| Material customer problem | Not met; no named customer evidence |
| Defensible benefit after shared dependencies | Not met; attribution is not a prototype |
| Offline and skipped-init behavior specified | Not met for deferred capabilities |
| Missing capability fails closed with repair | Not designed or implemented |
| New spec and ADR refine host-wired posture | Not present and not justified by evidence |

## Architecture and enforcement outcome

- Thread A: no new ADR and no supersession. It makes no dependency, bootstrap,
  language-admission, install, or capability-discovery change. The active
  [ADR-0034 host-wired language posture](../../decisions/ADR-0034-language-adapters-host-wired.md)
  remains unchanged.
- Thread B: no new ADR. It is an additive presentation/structured-result
  projection over the existing first-party adapter catalog and existing install
  commands, without a new architecture tradeoff.
- There is no new fitness check. Eligibility, installed-tool omission,
  human/JSON parity, and side-effect boundaries are covered by focused tests.
- Catalog drift remains mechanically enforced by bounded
  `validateAdapterEntries` generation tests and `pnpm adapter-catalog:check`.

## Limitations and air-gap boundary

- The installed footprint is one macOS arm64 environment with a prewarmed pnpm
  store; it is not a cross-platform distribution benchmark.
- Language attribution does not include or allocate shared dependencies and is
  not a measured slim-install result.
- Startup exercises the current full host-wired language substrate.
- Lifecycle code runs with the current user's filesystem authority. The portable
  runner is not an OS sandbox.
- The loopback sentinel covers configured registry/proxy traffic. It cannot
  attest that arbitrary lifecycle code did not open a direct socket or create a
  deliberately detached process; process cleanup is bounded and best-effort.
- The 50 ms descendant sampling interval cannot guarantee capture of a process
  that detaches and exits its parent between samples. Hard containment requires
  platform ownership primitives such as a Windows Job Object or POSIX cgroup /
  subreaper.
- The tarballs, prewarmed pnpm store, temporary consumer lock, and JSON report
  are measurement inputs and outputs only. They are not an offline bundle,
  mirror, container, installer, activation receipt, or rollback ledger, and
  must not be consumed as evidence for the separate air-gap distribution plan.
