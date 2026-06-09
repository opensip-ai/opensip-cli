/**
 * Workspace-invariant test: the plugin-kind contract.
 *
 * Plugin discovery keys off the `opensipTools.kind` marker in each
 * package's package.json. Historically some kinds were *also* discovered
 * by name prefix, which meant merely adding a
 * package under that prefix could silently change runtime discovery — that
 * is exactly how `@opensip-tools/graph-adapter-common` (shared scaffolding,
 * not an adapter) ended up being loaded as an adapter and warned on every
 * run.
 *
 * This test locks the contract at the source of truth — the real
 * package.json files in this repo — in BOTH directions:
 *
 *   - A package under a first-party plugin naming prefix MUST either declare
 *     the matching marker, or be on an explicit allowlist of "intentionally not
 *     a plugin". A new `graph-*` / `checks-*` package that is neither fails
 *     here, at PR time, instead of drifting away from the marker contract.
 *   - A package on an allowlist MUST NOT declare the plugin marker — so the
 *     allowlist can never silently mask a real plugin.
 *   - Every declared `kind` must be in the closed `MARKER_KINDS` vocabulary
 *     (catches typos like `graph_adapter`).
 *   - The first-party tool engines must keep their `tool` marker.
 *
 * The allowlists are the deliberate-intent mechanism: adding a `graph-*` or
 * `checks-*` package that is NOT a plugin forces a conscious one-line edit
 * here, with a reason.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SCOPE = '@opensip-tools';

/**
 * The valid `opensipTools.kind` markers, DERIVED (not compiled-in): the host
 * `'tool'` marker PLUS every marker kind a workspace manifest declares in a
 * marker-mode capability discovery descriptor (§5.3). The host no longer carries
 * a closed domain-marker vocabulary — `MARKER_KINDS` is `['tool']` now.
 */
function deriveValidMarkerKinds(packageJsonPaths: readonly string[]): Set<string> {
  const kinds = new Set<string>(['tool']);
  for (const p of packageJsonPaths) {
    const json = JSON.parse(readFileSync(p, 'utf8')) as {
      opensipTools?: { capabilities?: { discovery?: { discovery?: { mode?: string; markerKind?: string } } }[] };
    };
    for (const cap of json.opensipTools?.capabilities ?? []) {
      const mode = cap.discovery?.discovery;
      if (mode?.mode === 'marker' && typeof mode.markerKind === 'string') kinds.add(mode.markerKind);
    }
  }
  return kinds;
}

/** `graph-*` packages that intentionally are NOT graph adapters. */
const NON_ADAPTER_GRAPH_PACKAGES = new Set<string>([
  `${SCOPE}/graph-adapter-common`, // shared adapter scaffolding (no `adapter` export)
]);

/**
 * `checks-*` packages that intentionally are NOT fit packs.
 * None today — a future `checks-common` shared lib would be added here.
 */
const NON_PACK_CHECKS_PACKAGES = new Set<string>();

/** First-party tool engines that must carry the `tool` marker. */
const TOOL_PACKAGES = new Set<string>([
  `${SCOPE}/fitness`,
  `${SCOPE}/simulation`,
  `${SCOPE}/graph`,
]);

interface WorkspacePackage {
  readonly name: string;
  readonly kind: string | undefined;
  readonly relPath: string;
}

function findRepoRoot(start: string): string {
  let dir = start;
  let prev = '';
  while (dir !== prev) {
    try {
      readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8');
      return dir;
    } catch {
      // not the root — keep walking up
    }
    prev = dir;
    dir = dirname(dir);
  }
  throw new Error(`could not locate repo root (pnpm-workspace.yaml) from ${start}`);
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.claude', 'coverage']);

function collectPackageJsonPaths(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectPackageJsonPaths(join(dir, entry.name), out);
    } else if (entry.name === 'package.json') {
      out.push(join(dir, entry.name));
    }
  }
}

const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_JSON_PATHS: string[] = [];
collectPackageJsonPaths(join(REPO_ROOT, 'packages'), PACKAGE_JSON_PATHS);

function loadWorkspacePackages(): WorkspacePackage[] {
  const pkgs: WorkspacePackage[] = [];
  for (const p of PACKAGE_JSON_PATHS) {
    const json = JSON.parse(readFileSync(p, 'utf8')) as {
      name?: unknown;
      opensipTools?: { kind?: unknown };
    };
    if (typeof json.name !== 'string') continue; // fixtures without a name field
    const kind = json.opensipTools?.kind;
    pkgs.push({
      name: json.name,
      kind: typeof kind === 'string' ? kind : undefined,
      relPath: p.slice(REPO_ROOT.length + 1),
    });
  }
  return pkgs;
}

const PACKAGES = loadWorkspacePackages();
const VALID_MARKER_KINDS = deriveValidMarkerKinds(PACKAGE_JSON_PATHS);

describe('plugin-kind contract (workspace invariant)', () => {
  it('finds the workspace packages (sanity check on the walker)', () => {
    // If this is ever 0, the walker is broken and every assertion below is
    // vacuously true — guard against a silently-passing test.
    expect(PACKAGES.length).toBeGreaterThan(20);
    expect(PACKAGES.some((p) => p.name === `${SCOPE}/core`)).toBe(true);
  });

  it("every declared kind is 'tool' or a manifest-declared marker (descriptor-driven, not a host union)", () => {
    const valid = [...VALID_MARKER_KINDS].sort();
    const offenders = PACKAGES.filter((p) => p.kind !== undefined && !VALID_MARKER_KINDS.has(p.kind));
    expect(
      offenders,
      `package(s) declare an unknown opensipTools.kind (typo? must be one of ${valid.join(', ')}):\n` +
        offenders.map((p) => `  ${p.name} → "${p.kind}" (${p.relPath})`).join('\n'),
    ).toEqual([]);
  });

  it('every @opensip-tools/graph-* package is a declared graph-adapter or explicitly allowlisted', () => {
    const graphPrefixed = PACKAGES.filter((p) => p.name.startsWith(`${SCOPE}/graph-`));
    const offenders = graphPrefixed.filter(
      (p) => p.kind !== 'graph-adapter' && !NON_ADAPTER_GRAPH_PACKAGES.has(p.name),
    );
    expect(
      offenders,
      'package(s) under the `graph-*` prefix are neither declared graph adapters nor allowlisted.\n' +
        'Declare `"opensipTools": { "kind": "graph-adapter" }` in package.json, or — if this is\n' +
        'NOT an adapter (e.g. shared scaffolding) — add it to NON_ADAPTER_GRAPH_PACKAGES in this test:\n' +
        offenders.map((p) => `  ${p.name} → kind=${p.kind ?? 'none'} (${p.relPath})`).join('\n'),
    ).toEqual([]);
  });

  it('every @opensip-tools/checks-* package is a declared fit-pack or explicitly allowlisted', () => {
    const checksPrefixed = PACKAGES.filter((p) => p.name.startsWith(`${SCOPE}/checks-`));
    const offenders = checksPrefixed.filter(
      // eslint-disable-next-line sonarjs/no-empty-collection -- NON_PACK_CHECKS_PACKAGES is a deliberate, currently-empty extension seam, symmetric with the graph allowlist; a future checks-* shared lib gets added here.
      (p) => p.kind !== 'fit-pack' && !NON_PACK_CHECKS_PACKAGES.has(p.name),
    );
    expect(
      offenders,
      'package(s) under the `checks-*` prefix are neither declared fit packs nor allowlisted.\n' +
        'Declare `"opensipTools": { "kind": "fit-pack" }` in package.json, or — if this is\n' +
        'NOT a check pack (e.g. a shared lib) — add it to NON_PACK_CHECKS_PACKAGES in this test:\n' +
        offenders.map((p) => `  ${p.name} → kind=${p.kind ?? 'none'} (${p.relPath})`).join('\n'),
    ).toEqual([]);
  });

  it('allowlisted non-plugin packages do NOT declare the plugin marker', () => {
    // A package on a "not a plugin" allowlist must not also claim to be one,
    // or the allowlist would silently mask a real plugin.
    const masked = PACKAGES.filter(
      (p) =>
        (NON_ADAPTER_GRAPH_PACKAGES.has(p.name) && p.kind === 'graph-adapter') ||
        // eslint-disable-next-line sonarjs/no-empty-collection -- see note above: empty-today extension seam, not dead code.
        (NON_PACK_CHECKS_PACKAGES.has(p.name) && p.kind === 'fit-pack'),
    );
    expect(
      masked,
      'allowlisted package(s) declare the very marker they are allowlisted as NOT having:\n' +
        masked.map((p) => `  ${p.name} → "${p.kind}" (${p.relPath})`).join('\n'),
    ).toEqual([]);
  });

  it('first-party tool engines keep their tool marker', () => {
    const present = new Set(PACKAGES.map((p) => p.name));
    for (const toolName of TOOL_PACKAGES) {
      const pkg = PACKAGES.find((p) => p.name === toolName);
      expect(present.has(toolName), `expected tool package ${toolName} to exist in the workspace`).toBe(true);
      expect(pkg?.kind, `${toolName} must declare opensipTools.kind: "tool"`).toBe('tool');
    }
  });
});
