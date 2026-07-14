# Idea: Slimmer Install + Init-Time Capability / Opt-In Tools

**Status:** Thread B shipped; Thread A evidence-closed with the full-bundle posture retained.
**Captured:** 2026-07-10
**Last updated:** 2026-07-13 (init footer shipped; distribution evidence recorded)
**Intent:** Preserve the original discussion and its measured disposition. A packaging
revisit requires new customer evidence plus a separate spec/ADR/plan.

---

## One-liner

Today customers get the full stack on install. Two related ideas:

1. **Language capability** might not all ship in the default install — pull what
   the project needs when we know the languages (typically at `init`).
2. **`init` UX** should detect languages, optionally consent-install what’s
   needed for those languages, finish normal setup, then **list language-relevant
   opt-in `tool-*` adapters** using existing install commands (no new verbs).

These can graduate independently. The `tool-*` footer is lower risk and can ship
even if language-pack deferral never does.

---

## What is true today

- `opensip-cli` is a **full-stack bundle**: fit, graph, sim, yagni, mcp plus
  all `lang-*`, `checks-*` (incl. universal), and `graph-*` adapters.
- Core’s distribution note: a slim install without bundled tools is **not** a
  current goal.
- Language adapters are **statically registered** by the CLI composition root
  (`register-language-adapters.ts`).
- `init` already **detects languages** and scaffolds config/examples; it does
  **not** install packages. Fully-initialized re-run mostly refreshes agent
  guidance. A pristine success ends with **Try it** hints plus structured and
  human `tool-*` recommendations (and does not run a real smoke analysis).
- First-party **external tool adapters** live as `@opensip-cli/tool-*` and are
  already opt-in via:
  - `opensip tools list --available [--lang <language>]`
  - `opensip tools install <pkg>` (user-global default)
  - `opensip tools install <pkg> --project` (project `.runtime` host)
- Adapter catalog is generated (`FIRST_PARTY_ADAPTERS`); each row has
  `languages: [...]` (`[]` = polyglot, matches every `--lang` filter).
- Capability packs, plugin install/sync, and trust policy already exist.

---

## Layer model (do not collapse)

| Layer | Examples | Working lean (2026-07-10) |
|---|---|---|
| **Default / product tools** | fit, graph, sim, yagni, mcp | Always present; **global** (shipped with the CLI). Not a per-project choice. |
| **Language capability packs** | `lang-X`, `checks-X`, `graph-X` | Candidate for deferred install (open). Recommended-for-detected ≠ entire current multi-language bundle. |
| **Opt-in tools** | `@opensip-cli/tool-*` (gitleaks, ruff, govulncheck, …) | **Not** installed by default. Init **lists** ones relevant to detected languages. User installs later. Scope: **global or project** via existing flags. |

**Product tools stay product-core.** The opt-in surface is specifically `tool-*`,
not “optional fit/graph.”

---

## Thread A — Deferred language capability (evidence-closed)

The bounded evidence run is recorded in
[Deferred Language Distribution Evidence](../research/2026-07-12-deferred-language-distribution-evidence.md).
It measured a 117.21 MiB physical install, a 4.18 MiB installed OpenSIP tarball
closure, and 0.85 MiB of compressed language-family attribution. There is no
named customer evidence that install size or startup is a material pain point,
and attribution is not a measured slim-package saving.

**Disposition:** retain full bundle. No dependency, static language
registration, capability admission, or install behavior changed. ADR-0034 stays
active; any future deferral proposal must independently satisfy the graduation
gates below.

### Idea (raw)

1. Install does **not** ship every language’s packs by default.
2. On `init`, detect languages (existing logic).
3. Pull and install only the language-specific packages needed for that project.

### Why it might be worth it

- Install tax grows with every language; TS-only customers pay for Rust/Java/Go.
- Aligns with multi-language expansion without bloating every install.
- `init` is the natural “project shape” moment; detection exists.
- Existing capability-pack / plugin install seams could carry this.
- Story: “host ships verbs; language depth is project-scoped.”

### Why it might not (yet)

- Full bundle is boring reliability: works offline, agents just run.
- Need real numbers on transitive install size / cold-start pain.
- Silent under-analysis is worse than a fat install (missing packs → green CI).
- Agents often skip `init`.
- Mutating global `node_modules` from `init` is a bad model.
- Airgap / locked registries prefer install-once.
- Version/ABI skew between host and deferred packs (scope ABI already matters).

### Shape options (not selected)

- **A.** Language packs deferred; product tools stay bundled *(early favorite)*.
- **B.** Install profiles (full vs slim package).
- **C.** Keep full bundle; lazy-load heavy grammars/WASM only.
- **D.** Optional product tools too — out of scope for first cut.

### Early anti-patterns / bars

- Do **not** make `init` mutate the global CLI install as the primary design.
- Prefer project-local or versioned user-cache for deferred language packs
  (still open if we ever implement).
- Missing language pack must **never** look like a clean green run (fail closed
  + repair path).
- No new pack command family unless existing surfaces are insufficient.

---

## Thread B — Init UX (shipped 2026-07-13)

The low-risk footer shipped independently of Thread A. A successful pristine
init now projects relevant, uninstalled first-party `tool-*` adapters through
the shared catalog selector. Human output includes the existing install command,
network posture, the `--project` choice, and the full-catalog pointer;
`init --json` receives the same rows in additive `optionalTools` data. Refresh,
recovery, `--keep`, `--remove`, and failure paths remain quiet. Init does not
install or execute adapters.

### Desired flow (pristine, interactive TTY)

1. **Detect languages** (existing `detectLanguages` / `--language`).
2. **Ask consent** to install the **recommended/default packs for those
   languages** (if Thread A ships: language capability for detected langs only —
   not “install every language we support”).
3. On yes: install those packs (details TBD if Thread A proceeds).
4. **Continue normal init**: scaffold config/examples, agent guidance, gitignore,
   try-it hints (existing behavior). Prefer soft “Try it” over a full analysis
   smoke on first init (hard smoke is optional later / `doctor`-style).
5. **List opt-in `tool-*` adapters** relevant to detected languages, with
   **existing** install commands — **list only, do not auto-install** `tool-*`
   during init (current lean).

### Opt-in footer = `tool-*` only

- Catalog = first-party packages named `@opensip-cli/tool-*` (external adapters).
- Filter by **languages detected in the project**.
- Multi-language detect → **union** of matches across detected languages.
- **Polyglot adapters** (`languages: []` in catalog: gitleaks, trivy, osv-scanner,
  semgrep, ast-grep, dependency-check, …) — **lean include** them in the footer;
  otherwise TS-only projects see a nearly empty list (no language-specific
  `tool-eslint` today). Still open if we want polyglot out; recommended **in**.
- Omit or mark already-installed tools (`installedIds` already used by
  `tools list --available`).
- Optionally note `network: networked` vs `local-only` for airgap-minded users.

### Commands: reuse existing only

**No new commands.** Init only changes behavior/output.

```text
opensip tools list --available --lang <language>
opensip tools install @opensip-cli/tool-<name>           # global (default)
opensip tools install @opensip-cli/tool-<name> --project # project-local
```

Init should reuse the same catalog function as `tools list --available` (not
parse CLI text). Note: `--lang` is singular today; init multi-lang union is
in-process. Optional later: multi-value `--lang` for humans — not required.

### Install scope (working lean)

| Kind | Scope |
|---|---|
| Default product tools (fit/graph/…) | Always global / bundled with CLI |
| Opt-in `tool-*` | User chooses **global** (default on `tools install`) or **project** (`--project`) |

Init should **not** interactively ask global vs project. Footer shows the default
command and notes `--project` for repo-local.

### Non-interactive / agents / CI

- Footer is **print-only** → agents benefit with zero prompts.
- If Thread A adds a consent-install step:
  - TTY pristine: prompt (Enter default **Y** — agreed lean).
  - `--yes` / `-y`: install recommended without prompt.
  - `--no-install` / skip packs: scaffold only + loud next steps.
  - Non-TTY: must not hang; require flag or scaffold-only + loud next step.
- Decline / skip path: still scaffold; fail closed at analysis if capability
  missing; never quiet under-powered green.

### Re-init

- Fully-initialized “refresh guidance” path should stay quiet.
- Full pack prompt / full `tool-*` catalog: pristine (or explicit re-install /
  missing capability), not every guidance refresh.
- Optional: one-line pointer to `tools list --available` on refresh.

### Sketch output (illustrative)

```text
$ opensip init

Detected languages: typescript, python

Install recommended packs for typescript + python? [Y/n]
  … (only if Thread A ships) …

✓ Scaffolded for typescript, python in /repo
    opensip-cli.config.yml
    opensip-cli/fit/...
    Agent guidance: …
    .gitignore (opensip-cli/.runtime/)

  Try it:
    opensip fit --recipe example
    opensip graph

  Optional tools for this project (not installed):
    ruff          opensip tools install @opensip-cli/tool-ruff
    bandit        opensip tools install @opensip-cli/tool-bandit
    pip-audit     opensip tools install @opensip-cli/tool-pip-audit
    gitleaks      opensip tools install @opensip-cli/tool-gitleaks
    trivy         opensip tools install @opensip-cli/tool-trivy
    osv-scanner   opensip tools install @opensip-cli/tool-osv-scanner
    …

    Use --project on tools install for repo-local instead of global.
    Full catalog: opensip tools list --available
```

---

## Settled outcome

| Topic | Lean |
|---|---|
| Product tools optional? | **No** — stay bundled/global |
| Opt-in surface | **`tool-*` only**, language-filtered (+ polyglot recommended) |
| New CLI verbs for this? | **No** — `tools list --available`, `tools install` [`--project`] |
| Init installs `tool-*`? | **No** — list + commands only |
| Enter on pack consent (if any) | **Y** |
| Multi-language detect | Union of language-matched opt-in tools |
| Global vs project for opt-in | User choice later; show both via flags, no second prompt |
| Mutate global CLI from init for language packs? | **Anti-pattern** |
| Silent missing capability | **Forbidden** |
| Thread A evidence outcome | Current full bundle stays in place |
| Thread B delivery | Shipped as pristine-init human + JSON recommendations |

---

## Inputs required before reopening Thread A

### Language-pack distribution

1. Named customer evidence that install size or startup is material.
2. A measured prototype showing benefit after shared dependencies.
3. Where do deferred language packs land (project / user-cache / other)?
4. Install only at `init` vs first use vs explicit repair?
5. Version pin / ABI contract for deferred packs?
6. Airgap full-bundle profile?
7. Keep full bundle and only ship Thread B (`tool-*` footer)?

### Optional future init-copy refinements

1. Polyglot `tool-*` in footer: **include** (lean) or exclude?
2. Exact footer copy density (one line per tool vs grouped)?
3. Consent remains out unless a future Thread A design is authorized.
4. Whether networked tools get a visual mark in the footer?

### Cross-cutting

- The 2026-07-13 evidence baseline supplies size/time numbers; a future
  commitment still requires named customer evidence and a measured prototype.
- Graduation only if still liked: discuss → evidence → ADR → design → implement.
  Do not jump to implement.

---

## Existing seams to reuse (if anything ships)

- `detectLanguages` / `--language` on `init`
- `bundledCapabilityPacks` / capability-pack trust ADRs
- `opensip tools list --available [--lang]` + `FIRST_PARTY_ADAPTERS`
- `opensip tools install` / `--project` (ADR-0041)
- Plugin add/sync host ops
- Scope ABI compatibility
- Init scaffold + agent guidance + try-it (current success path)

---

## Graduation path for any future deferral proposal

1. Collect named customer evidence and define the material problem.
2. Build and measure a concrete distribution prototype.
3. Specify offline, skipped-init, version/ABI, and fail-closed repair behavior.
4. Write a new spec and ADR that explicitly addresses ADR-0034.
5. Create a separate implementation plan only after those gates pass.

---

## Discussion log (summary)

### Pass 1 — distribution idea

- Slimmer install; language packs on `init` after detection.
- Separate tools vs language packs; early lean tools stay core.
- Risks: global mutation, silent empty runs, agents skip init, airgap, ABI.

### Pass 2 — init UX shape

- Detect → consent for recommended language packs → install → normal init
  (scaffold, agent files, try-it) → list opt-in packages with commands.
- Progressive disclosure: defaults first, options last.
- Non-interactive matrix required; re-init must not re-nag; decline path
  first-class.

### Pass 3 — opt-in = `tool-*`; reuse existing commands

1. Agree Enter-default Y for consent when present.
2. Opt-in list is **not** “recommended product tools” and **not** other
   language packs — it is **all opt-in `tool-*`**, filtered to languages
   detected in the project.
3. Multi-language = that same filter (union).
4. Default product tools always **global**; opt-in tools **global or project**
   (user choice; existing `tools install` / `--project`).
5. **No new commands** — only init behavior; use current tools management
   surface.

Paused here for later return.

### Pass 4 — implementation and evidence closure (2026-07-13)

1. Shipped pristine-init `tool-*` recommendations for humans and agents through
   one shared, generated catalog selector.
2. Preserved quiet refresh/recovery/keep/remove behavior and added no install
   side effect, prompt, flag, or command.
3. Added a bounded packed-distribution measurement harness and ran the complete
   57-tarball set from commit `2ff9fb30` in offline-cache mode.
4. Recorded the hash-identified report, negative offline probes, measurement
   limitations, and the absence of named customer pain evidence.
5. Kept ADR-0034 and the full host-wired language substrate unchanged. Thread A
   now requires a new evidence-backed architecture exercise rather than an
   extension of this work.
