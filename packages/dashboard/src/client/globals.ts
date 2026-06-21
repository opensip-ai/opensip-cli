/**
 * Ambient declarations for the dashboard client bundle (L4 migration).
 *
 * The generated report `<script>` opens with a const block emitted by
 * `generator.ts` (sessions, the tool catalogs, the registry-derived Overview
 * maps, the per-tool session splits). The bundled client modules — which run in
 * that same `<script>` scope — read those as free identifiers. Declaring them in
 * a `declare global` block lets the client `tsconfig.json` type-check the modules
 * without each one re-deriving the inputs.
 *
 * This is a regular module (`export {}` makes it a module so `declare global`
 * augments the global scope) rather than a `.d.ts` — the stale-build-artifact
 * fitness check forbids `.d.ts` files in source directories, and a `declare
 * global` module emits no runtime code (esbuild never bundles it; tsc uses it for
 * type-checking only).
 *
 * The catalog entry shapes are tool domain vocabulary (fitness/sim/graph),
 * inlined as JSON and read structurally by the renderers — hence `unknown` for
 * the opaque tool-owned payloads and `readonly unknown[]` for the catalogs.
 *
 * Cross-module helpers that one migrated module needs from another (e.g.
 * `renderSessionTable`) are imported directly via `./<module>.js`, NOT declared
 * here — these globals are only the generator-injected data.
 */

declare global {
  /** A persisted run row, as inlined by `generator.ts` (read structurally). */
  interface DashboardSession {
    id: string;
    tool: string;
    startedAt: string;
    recipe?: string;
    score: number;
    durationMs: number;
    cwd: string;
    /** Tool-owned opaque payload (fitness/sim/graph carry their own shapes). */
    payload?: {
      summary?: {
        total?: number;
        passed?: number;
        failed?: number;
        errors?: number;
        warnings?: number;
      };
      checks?: readonly unknown[];
    };
  }

  // ---- Generator-injected data globals (the report <script> const block) ----

  const sessions: readonly DashboardSession[];
  const fitSessions: readonly DashboardSession[];
  const simSessions: readonly DashboardSession[];

  const checkCatalog: readonly unknown[];
  const recipeCatalog: readonly unknown[];
  const simScenarioCatalog: readonly unknown[];
  const simRecipeCatalog: readonly unknown[];

  /**
   * Overview's `tool → inline badge style` and `tool → tab id` maps. Derived
   * from the `defineToolTab` registry in `generator.ts` and emitted as page
   * globals so the registry derivation stays type-checked Node code rather than a
   * string template (F1/F8).
   */
  const toolBadgeStyles: Readonly<Record<string, string>>;
  const tabMap: Readonly<Record<string, string>>;
}

export {};
