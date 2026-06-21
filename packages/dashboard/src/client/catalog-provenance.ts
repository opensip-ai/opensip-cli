/**
 * Catalog provenance bar for the Explore tab.
 *
 * The Explore views (Coupling / Functions / Visualization) all render from the
 * single cached graph catalog — the LATEST `graph` build, whatever its scope.
 * A scoped run (`graph packages/contracts`) or a stale build therefore narrows
 * every view, with no on-page indication. This bar surfaces what the views are
 * built from — package scope, function count, build time, and engine — so a
 * scoped/stale catalog is self-explanatory. Every value is DERIVED from the
 * embedded catalog itself, so it is ground truth.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 */

import { el } from './el.js';
import { packagesInCatalog } from './filters.js';

import type { CatalogLike } from './code-paths-types.js';

/** Optional styling for a provenance chip. */
interface ChipOpts {
  title?: string;
  color?: string;
}

// Build engine ('sharded' | 'exact') parsed from the catalog cache key
// (e.g. "eng=0.1.0|mode=sharded|..."). Null when the marker is absent.
function catalogEngineMode(catalog: CatalogLike | null): string | null {
  const m = /(?:^|\|)mode=([a-z]+)/.exec(catalog?.cacheKey ?? '');
  return m ? m[1] : null;
}

// Total function OCCURRENCES across the catalog (each occurrence is one graph
// node) — the catalog's size, not just distinct names.
function catalogFunctionCount(catalog: CatalogLike | null): number {
  if (!catalog?.functions) return 0;
  let n = 0;
  for (const name of Object.keys(catalog.functions)) n += (catalog.functions[name] ?? []).length;
  return n;
}

// Coarse "N <unit> ago" for the build time. Browser Date.now() is fine here
// (this is page JS, not the engine's Date.now()-free pure layer).
function provenanceRelTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return mins + ' min' + (mins === 1 ? '' : 's') + ' ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + ' hour' + (hrs === 1 ? '' : 's') + ' ago';
  const days = Math.round(hrs / 24);
  return days + ' day' + (days === 1 ? '' : 's') + ' ago';
}

function provenanceChip(label: string, value: string, opts?: ChipOpts): HTMLElement {
  const o = opts ?? {};
  const chip = el('span', { style: 'display:inline-flex;align-items:baseline;gap:6px' });
  chip.append(
    el('span', {
      text: label,
      style:
        'color:var(--text-dim);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em',
    }),
  );
  chip.append(
    el('span', {
      text: value,
      title: o.title ?? '',
      style: 'color:' + (o.color ?? 'var(--text)') + ';font-weight:600;font-size:13px',
    }),
  );
  return chip;
}

// Render the provenance bar into host. No-op when no catalog is loaded (the
// caller already shows a "No catalog yet." empty state in that case).
export function renderCatalogProvenance(host: HTMLElement, catalog: CatalogLike | null): void {
  if (!catalog) return;
  const pkgs = packagesInCatalog(catalog);
  const fnCount = catalogFunctionCount(catalog);
  const engine = catalogEngineMode(catalog);
  const builtAtIso = catalog.builtAt;
  const builtAt = builtAtIso ? new Date(builtAtIso) : null;

  const bar = el('div', {
    class: 'catalog-provenance',
    style:
      'display:flex;flex-wrap:wrap;align-items:center;gap:10px 20px;margin:0 0 16px;padding:10px 14px;border:1px solid var(--border);border-radius:8px;background:var(--bg-card)',
  });

  // Scope is the headline signal: 1 package vs the whole repo. List the names
  // inline when the set is small (so a scoped build reads "1 package: contracts"
  // directly); always carry the full sorted list in the title for hover.
  const pkgLabel = pkgs.length === 1 ? '1 package' : String(pkgs.length) + ' packages';
  const pkgNames = pkgs.length > 0 && pkgs.length <= 4 ? ': ' + pkgs.join(', ') : '';
  bar.append(
    provenanceChip('Scope', pkgLabel + pkgNames, {
      color: 'var(--accent)',
      title: pkgs.join(', '),
    }),
  );

  bar.append(provenanceChip('Functions', fnCount.toLocaleString()));

  if (builtAtIso && builtAt && !Number.isNaN(builtAt.getTime())) {
    bar.append(
      provenanceChip('Built', provenanceRelTime(builtAtIso), {
        title: builtAt.toLocaleString(),
      }),
    );
  }

  if (engine) bar.append(provenanceChip('Engine', engine));

  // 'fast' resolution = syntactic (approximate) edges, so the coupling matrix /
  // visualization are approximate too. 'exact' is the default and needs no flag.
  if (catalog.resolutionMode === 'fast') {
    bar.append(provenanceChip('Resolution', 'fast (approximate)', { color: 'var(--warning)' }));
  }

  host.append(bar);
}
