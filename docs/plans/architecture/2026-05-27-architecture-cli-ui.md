# Architecture audit — cli-ui

**Date:** 2026-05-27
**Scope:** packages/cli-ui
**Auditor:** Claude

## Summary

`packages/cli-ui` is a small (~7 source files, ~340 LOC) presentational kit
that does most things right for its size: zero opensip-tools dependencies,
no inbound reach into the dispatcher, one-concern-per-file, narrow public
surface (`src/index.ts`), and React context used appropriately for both
theming and animation timing. SOLID hygiene is generally sound (DIP via
React context, ISP via per-component prop interfaces, OCP via the `Theme`
interface accepting any conforming object). Tests cover every primitive.

The audit found a handful of actionable issues — mostly around weak
abstractions in the theme contract, presentation-state leakage in the
`Spinner` API, and modest DRY/encapsulation slips in clock/spinner and
project-line formatting. None are severe; all are addressable without
breaking the public surface. There are no Gang-of-Four anti-patterns
(no inheritance misuse, no god-objects, no Singletons), but two GoF
opportunities (a Strategy/Factory split inside `ThemeProvider` and a
`Theme` extension point for tools that want their own tokens) would
materially improve evolvability.

## Findings

### F1 — `Theme` is a closed, hard-coded token bag; pluggability is partial

- **Files:** `packages/cli-ui/src/theme.ts:14`, `packages/cli-ui/src/theme.ts:41`
- **Principle/Pattern:** Open/Closed, Interface Segregation, Strategy
- **Status:** Problematic
- **Evidence:**
  ```ts
  // theme.ts:14
  export interface Theme {
    readonly brand: string;
    readonly success: string;
    /* …14 fixed string tokens, including scoreHigh/scoreMid/scoreLow,
       statusPass/statusFail/statusTimeout — these are fitness-domain tokens */
  }
  ```
  Tokens like `scoreHigh`, `scoreMid`, `scoreLow`, `statusPass`,
  `statusFail`, `statusTimeout` are not generic CLI-UI tokens — they are
  fitness-domain semantics that leaked up into the shared layer. A future
  `audit`/`lint`/`bench` tool would either (a) reuse misleadingly-named
  tokens, or (b) need to fork `Theme`.
- **Why it matters:** `Theme` advertises itself as the pluggable surface
  for OCP (anyone can pass `theme={...}` to `ThemeProvider`), but its
  shape is closed against extension: there is no escape hatch for
  tool-specific tokens, and the interface mixes generic semantics
  (`brand`, `success`, `error`, `muted`) with fitness-only semantics
  (score buckets, check-status). Tools either shoe-horn or duplicate
  the theme machinery downstream.
- **Recommendation:** Split into a core `Theme` (generic semantic colors:
  brand, success, error, warning, info, muted, plus `colorsEnabled`) and
  domain extensions (`FitnessTheme extends Theme`, etc.) lived next to
  their tools. Alternatively, add an open `tokens: Readonly<Record<string, string>>`
  field on `Theme` and provide a typed `useThemeToken('scoreHigh')` lookup.
  Domain-aware tools register their token namespaces; the kit stays
  domain-neutral.

### F2 — `Spinner` mixes two responsibilities (frame source + label/progress); state hooks are correct but the props leak presentation choice

- **Files:** `packages/cli-ui/src/spinner.tsx:37`, `packages/cli-ui/src/spinner.tsx:49`
- **Principle/Pattern:** Single Responsibility, Composition over flags
- **Status:** Problematic
- **Evidence:**
  ```ts
  // spinner.tsx:49
  export function Spinner({ total, completed, label = 'Running...', standalone = false }: SpinnerProps): React.ReactElement {
    return standalone
      ? <SpinnerStandalone … />
      : <SpinnerCtx … />;
  }
  ```
  `standalone` is a boolean flag whose only effect is to switch which
  hook (`useSpinner` vs `useStandaloneSpinner`) provides the tick. The
  component also bundles count/percent formatting (`SpinnerLine`) into
  the same primitive.
- **Why it matters:** The flag-toggle is a textbook code smell — two
  different "spinner" implementations dispatched by a boolean. It also
  ties the API to an implementation choice (provider vs no-provider)
  that callers shouldn't need to make explicit; if a caller has a
  `ClockProvider` upstream they'd expect the spinner to use it
  automatically. As written, every caller hard-codes one path. Adding
  a third tick source (e.g., explicit `ticker` prop, or a
  PerformanceObserver-driven tick) would require a second flag or a
  union prop. The mixing of progress-formatting with frame production
  also blocks reuse of the spinner glyph alone.
- **Recommendation:** Remove `standalone`. Make `Spinner` always read
  `useClock()`; render a no-op (or default standalone tick) only when
  no `<ClockProvider>` is mounted — detect by giving `ClockContext` a
  sentinel default (`null` or a never-ticking value) and falling back
  to `useTick()` inside the component itself. Alternatively, lift the
  progress-formatting (`{completed}/{total} ({pct}%)`) into a tiny
  `<Progress />` primitive and let callers compose
  `<Spinner /><Progress />`. Either way the public surface narrows.

### F3 — `useTick` and `ClockProvider` duplicate identical interval logic

- **Files:** `packages/cli-ui/src/clock.ts:27`, `packages/cli-ui/src/clock.ts:48`
- **Principle/Pattern:** DRY, Single Responsibility
- **Status:** Problematic
- **Evidence:**
  ```ts
  // clock.ts:27 — ClockProvider
  useEffect(() => {
    const id = setInterval(() => setTick((p) => p + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  // clock.ts:48 — useTick
  useEffect(() => {
    const id = setInterval(() => setTick((p) => p + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  ```
  The two implementations are byte-identical except where the tick is
  consumed. The intent comment (a single shared timer in provider mode,
  one-per-component in standalone mode) is the only behavioral
  difference, and that's a context-consumption difference, not a timer
  difference.
- **Why it matters:** Two copies of the same effect drift over time —
  the obvious example is tab-visibility / `process.stdout.isTTY` /
  shutdown handling: adding `clearInterval` on `SIGINT` would have to
  be done in both places. Encapsulation is also weakened: the
  `ClockProvider` exposes `tick` via context but not the underlying
  hook, so consumers can't access "the same hook with a fresh timer"
  without learning about both APIs.
- **Recommendation:** Extract `useIntervalTick(intervalMs): number`
  as the single source of truth. `ClockProvider` becomes
  `value={useIntervalTick(intervalMs)}` over its context; `useTick`
  becomes a one-line re-export of the same hook. Any future change
  (visibility pause, suspend on `process.stdout` close, custom
  scheduler) lands once.

### F4 — `useClock` outside a provider silently returns `0` forever — fail-soft surprises callers

- **Files:** `packages/cli-ui/src/clock.ts:20`, `packages/cli-ui/src/clock.ts:40`
- **Principle/Pattern:** Liskov / least surprise, Null Object misuse
- **Status:** Problematic
- **Evidence:**
  ```ts
  // clock.ts:20
  const ClockContext = createContext<number>(0);

  // clock.ts:40
  export function useClock(): number { return useContext(ClockContext); }
  ```
  `useSpinner` (`spinner.tsx:26`) calls `useClock()` directly; if a
  caller mounts `<Spinner />` (non-standalone) outside a
  `<ClockProvider>`, the spinner never animates — silently. The test
  at `clock.test.tsx:29` even asserts the silent-zero behavior.
- **Why it matters:** This is a classic Null Object misuse: a value
  that's syntactically valid but semantically wrong, with no warning.
  In practice the bug surfaces as "the spinner doesn't spin in tool X"
  and the cause (missing provider) is invisible. The `standalone` flag
  in `SpinnerProps` exists in part to paper over this — see F2.
- **Recommendation:** Make the context value carry an explicit
  signal — e.g., `ClockContext = createContext<number | null>(null)`
  and have `useClock` throw or warn (dev-only) when called outside a
  provider; have `useSpinner` fall back to `useTick()` when null. Or
  more simply, never use the bare context default — always wrap the
  app in a `ClockProvider` and assert non-null at the hook boundary.
  This eliminates F2's `standalone` flag in the same stroke.

### F5 — `formatProjectLine` (RunHeader) and `formatProjectHeader` (imperative) are near-duplicate formatters

- **Files:** `packages/cli-ui/src/run-header.tsx:36`, `packages/cli-ui/src/project-header.ts:29`
- **Principle/Pattern:** DRY, Single Source of Truth
- **Status:** Problematic
- **Evidence:**
  ```ts
  // run-header.tsx:36
  function formatProjectLine(projectRoot: string, walkedUp: number): string {
    if (walkedUp === 0) return `Project: ${projectRoot}`;
    const noun = walkedUp === 1 ? 'level' : 'levels';
    return `Project: ${projectRoot}  (found ${walkedUp} ${noun} up)`;
  }

  // project-header.ts:29
  export function formatProjectHeader(input: ProjectHeaderInput): string {
    const base = `ℹ Project: ${input.root}`;
    if (input.walkedUp === 0) return `${base}\n`;
    const noun = input.walkedUp === 1 ? 'level' : 'levels';
    return `${base}  (found ${input.walkedUp} ${noun} up)\n`;
  }
  ```
  Two pluralization rules ("level/levels"), two body templates, two
  test files asserting both must stay in sync. The only differences
  are the leading `ℹ` and a trailing `\n` — both are presentation
  decisions, not body decisions.
- **Why it matters:** When the body format changes (say, swapping
  `(found N levels up)` for `(N levels up from cwd)`), only one of
  the two functions will be updated and the live-view path will
  diverge from the imperative path. CLAUDE.md explicitly calls out
  that these two paths must "cover every command path exactly once
  — no duplicate Target:/Project: lines"; consistency between them
  is a stated invariant.
- **Recommendation:** Extract a pure helper
  `formatProjectBody({ root, walkedUp }): string` that returns the
  bare body (`Project: <root>  (found …)`). `formatProjectHeader`
  composes `ℹ ${body}\n`; `RunHeader` composes
  `${metadata.join('   ')}   ${body}` (or uses it directly inside
  `metaParts`). One pluralization rule, one body, one source of truth.

### F6 — Public surface conflates Provider and detection helper; tools can construct partial themes that break invariants

- **Files:** `packages/cli-ui/src/theme.ts:140`, `packages/cli-ui/src/index.ts:22`
- **Principle/Pattern:** Encapsulation, Factory Method
- **Status:** Missing opportunity
- **Evidence:**
  ```ts
  // theme.ts:140
  export function ThemeProvider({ theme, children }: ThemeProviderProps): React.ReactElement {
    const resolved = React.useMemo(() => {
      if (theme) return theme;
      const caps = detectTerminalCapabilities();
      return caps.supportsColor ? DEFAULT_THEME : NO_COLOR_THEME;
    }, [theme]);
    …
  }
  ```
  `NO_COLOR_THEME` is private. If a caller passes an explicit `theme`,
  the NO_COLOR fallback is bypassed — meaning a caller who provides a
  custom theme *must* re-implement no-color handling themselves, or
  ANSI escapes leak into piped output. The factory logic
  ("pick a theme based on caps") is hidden inside the provider and
  not reachable for callers who want to compute the theme in advance
  (e.g., for memoization in a custom provider, or to pass into a
  detached static-render path).
- **Why it matters:** This is a soft Factory Method opportunity. Right
  now, "what's the right theme for this terminal?" is answerable in
  one place — inside the provider's `useMemo`. Anyone else has to
  re-derive it. And the NO_COLOR-vs-supplied-theme interaction is a
  silent footgun.
- **Recommendation:** Export `resolveTheme(overrides?: Partial<Theme>): Theme`
  as the canonical factory: applies NO_COLOR coercion when capabilities
  warrant, merges overrides over the base. `ThemeProvider` becomes
  `value={resolveTheme(theme)}`. Custom callers (e.g., snapshot
  renderers, embedded SaaS modes) call `resolveTheme(undefined)` once
  and reuse it. Document that NO_COLOR semantics apply uniformly.

### F7 — `Banner` ASCII art is a presentation primitive but is also a brand asset, with no extension point

- **Files:** `packages/cli-ui/src/banner.tsx:12`, `packages/cli-ui/src/banner.tsx:25`
- **Principle/Pattern:** Open/Closed
- **Status:** Missing opportunity (low priority)
- **Evidence:**
  ```ts
  // banner.tsx:25
  export function Banner(): React.ReactElement { … }
  ```
  The component takes zero props. The art is a hard-coded constant
  scoped to the module. There is no way for an embedder (a downstream
  SaaS host, a white-label tool) to override the banner without
  forking the file. Note: CLAUDE.md explicitly calls out a
  "SaaS-ready" invariant — features must work in both embedded and
  SaaS modes.
- **Why it matters:** For a v1 OSS tool the OpenSIP banner is the
  point. For a SaaS embedding, brand-locking via a presentational
  primitive is the kind of thing that gets re-discovered later as
  technical debt. The current shape (zero props, module-level
  constant) gives no path forward without a breaking change.
- **Recommendation:** Two reasonable options. (a) Cheap: accept an
  optional `art?: readonly string[]` prop with the OpenSIP art as the
  default. (b) Slightly bigger: expose a `BannerContent` slot/render
  prop and let downstream callers compose their own art into the
  same color/layout shell. Either keeps the v1 tool unchanged.

### F8 — `useTheme()` is the only consumer protocol; no way to opt out of context for one-shot static renders

- **Files:** `packages/cli-ui/src/banner.tsx:26`, `packages/cli-ui/src/spinner.tsx:56`, `packages/cli-ui/src/run-header.tsx:48`, `packages/cli-ui/src/error-message.tsx:17`
- **Principle/Pattern:** Dependency Inversion, Composition
- **Status:** Correct (note only)
- **Evidence:** Every component reads theme via `useTheme()` rather than
  taking a `theme` prop directly. `useTheme()` returns `DEFAULT_THEME`
  when no provider is mounted (theme.ts:133, 157).
- **Why it matters:** This is the right call — it scales cleanly with
  composition and avoids prop-drilling. Worth recording as a strength,
  but flagging an associated trade-off: there is no way to render
  `<Banner theme={x} />` ad-hoc without a provider. For deeply nested
  one-shot renders, that's an acceptable cost. No change recommended;
  noted to forestall future "let's add a `theme` prop" PRs.
- **Recommendation:** None. Document the pattern in `index.ts` or a
  short `THEMING.md` so future contributors don't add prop-drilling.

### F9 — `RunHeader.metaParts` joins with three spaces, hard-coding presentation layout

- **Files:** `packages/cli-ui/src/run-header.tsx:52`
- **Principle/Pattern:** Open/Closed, Separation of concerns
- **Status:** Problematic (minor)
- **Evidence:**
  ```ts
  // run-header.tsx:52
  const metaParts = [
    ...metadata.map((m) => `${m.label}: ${m.value}`),
    formatProjectLine(projectRoot, walkedUp),
  ];

  return (
    …
    <Text dimColor>{metaParts.join('   ')}</Text>
    …
  );
  ```
  The label/value pairs are flattened into a single dim-colored line
  using literal `'   '` (three spaces) as the separator. Long metadata
  (a long project path + a long recipe name) will wrap unpredictably
  in narrow terminals, and there's no way for a tool to opt into a
  vertical "key: value\nkey: value" layout.
- **Why it matters:** Tools have different metadata density. The fit
  runner has 2–3 keys; a hypothetical bench runner with 6 metrics
  would need a multi-line layout. As-is, layout is encoded into the
  component, not configurable.
- **Recommendation:** Replace the joined `<Text>` with a `<Box flexDirection="row" gap={3}>`
  containing one `<Text>` per pair, or accept a `layout?: 'inline' | 'stacked'`
  prop. Cheap fix; preserves backward compatibility.

### F10 — `ErrorMessage` hard-codes the `✗` glyph and the 4-space suggestion indent

- **Files:** `packages/cli-ui/src/error-message.tsx:23`, `packages/cli-ui/src/error-message.tsx:28`
- **Principle/Pattern:** Open/Closed, Presentation/data separation
- **Status:** Problematic (minor)
- **Evidence:**
  ```ts
  // error-message.tsx:23
  <Text color={theme.error}>{'✗'}</Text>

  // error-message.tsx:28
  <Text dimColor>{'    '}{suggestion}</Text>
  ```
  The cross glyph and the 4-space prefix are baked in. A no-Unicode
  terminal (or a structured-output sink) cannot swap them.
- **Why it matters:** Mirrors the missed extension point in `Banner`
  (F7). Terminal-capability detection in `theme.ts` already
  distinguishes truecolor / 256color / dumb — it would be consistent
  for `ErrorMessage` to honor a no-Unicode capability flag (e.g.,
  fall back to `X` on dumb terminals or when an `asciiOnly` cap is
  set).
- **Recommendation:** Add `asciiOnly` to `TerminalCapabilities` (false
  by default; true on `TERM=dumb`) and let `ErrorMessage` (and
  `Spinner`) consult it. Alternatively, expose `icon?: string` /
  `indent?: number` props with the current values as defaults.

### F11 — `Banner.BANNER` array is recreated as a module-scoped readonly tuple, but each row is destructured per render

- **Files:** `packages/cli-ui/src/banner.tsx:12`, `packages/cli-ui/src/banner.tsx:30`
- **Principle/Pattern:** React performance / memoization
- **Status:** Correct (note only)
- **Evidence:** `BANNER` is module-scoped (allocated once). The `.map`
  inside `Banner()` runs on every render; the component takes no
  props, so React.memo would make every render a no-op.
- **Why it matters:** With a `<ClockProvider>` tick at 80ms,
  `Banner` re-renders ~12.5 times/sec for the duration of a run. Each
  render allocates 8 destructured `[cup, openPart, sipPart]` triples
  and 8 ReactElement trees, just to produce identical output. Mild
  but real CPU/GC pressure during long fitness runs. The same
  consideration applies to any other purely-derived-from-theme
  component that re-renders on every tick (the only true tick
  consumer is `Spinner`, but `Banner` and `RunHeader` are children
  of the same provider and re-render with it unless memoized).
- **Recommendation:** Wrap `Banner` in `React.memo()`. Same for
  `RunHeader` (its props are simple and shallow-equal-friendly), and
  for `ErrorMessage`. Cheap; measurable for live-view tools.

### F12 — `cli-ui` correctly avoids reaching back into `cli`; contract direction is clean

- **Files:** `packages/cli-ui/package.json:27`, `packages/cli-ui/src/index.ts`
- **Principle/Pattern:** Dependency Inversion, Layering
- **Status:** Correct (strength)
- **Evidence:** Dependencies are `ink` and `react` only — no
  `@opensip-tools/*` deps. The CLI (`packages/cli/src/ui/render.tsx:11`,
  `App.tsx:5`) imports from cli-ui; the reverse never happens. Tools
  (`packages/fitness/engine/src/cli/fit-runner.tsx:32`,
  `packages/graph/engine/src/cli/graph-runner.tsx:30`) consume cli-ui
  directly, which is exactly the stated design ("tools that ship a
  live view depend on the UI kit without pulling in the dispatcher").
- **Why it matters:** This is the headline architectural property of
  the package and it holds. Worth recording so future "let's just add
  a small helper that uses ToolCliContext" PRs get pushed back.
- **Recommendation:** None — keep the invariant. Consider adding a
  dependency-cruiser rule forbidding `cli-ui → cli` / `cli-ui → fitness`
  / `cli-ui → simulation` / `cli-ui → graph` so the next contributor
  doesn't accidentally cross-link.

## Strengths

- **Clean layering** — zero opensip-tools deps, no reach into the
  dispatcher, components depend only on `ink`/`react`. The contract
  with `cli` flows in one direction.
- **One-concern-per-file** — banner, spinner, clock, theme, error,
  run-header, project-header. Easy to evolve in isolation.
- **DIP via React context** — `useTheme()` and `useClock()` are the
  uniform consumer protocols; no prop-drilling.
- **Pure imperative helper alongside React** — `formatProjectHeader`
  is correctly carved out as a non-React string formatter, so the
  pre-action hook doesn't pay React's render cost.
- **NO_COLOR semantics are coherent** — `NO_COLOR_THEME` zeroes every
  token (theme.ts:66) rather than relying on `colorsEnabled` checks
  at every call site. Good defensive design.
- **Memoization in `ThemeProvider`** is correct and intentional
  (theme.ts:148, with a worthwhile comment explaining the why).
- **Test coverage** — every primitive has a dedicated test file using
  `ink-testing-library`. Tick behavior uses fake timers.
- **Public surface is narrow** — `index.ts` is the only export
  barrel; nothing is re-exported by accident.

## Notes

- Findings F2, F3, and F4 are interlocked: fixing F4 (give
  `ClockContext` a sentinel default and detect missing provider)
  collapses F2's `standalone` flag and naturally factors the duplicate
  interval logic in F3. Worth doing as one small refactor rather than
  three separate ones.
- Findings F1 and F6 are also related: a `resolveTheme` factory (F6)
  composes cleanly with a split `Theme` / `FitnessTheme` (F1).
- The package has no GoF anti-patterns to flag (no inheritance, no
  god-class, no Singleton misuse). The opportunities are
  Strategy/Factory shaped, not anti-pattern shaped.
- Consider adding a one-line `dependency-cruiser` rule (F12) and a
  brief `THEMING.md` (F8) — both are zero-effort hardening of the
  package's stated invariants.
