/**
 * `tools list --available [--lang <l>]` — the opt-in External Tool Adapter catalog.
 *
 * Unlike {@link toolsList} (the effective/installed set), this describes adapters
 * the user could install but may NOT have on disk. The universe is the CLI-bundled
 * {@link FIRST_PARTY_ADAPTERS} catalog (a build-time projection of every adapter's
 * manifest), cross-referenced with the run's installed ids so each row is marked
 * installed / not-installed. Pure — no dynamic import, no filesystem beyond what the
 * caller already resolved.
 */

import { FIRST_PARTY_ADAPTERS, type FirstPartyAdapter } from './first-party-adapters.generated.js';

import type { ToolsAvailableResult, ToolsAvailableRow } from '@opensip-cli/contracts';

/** Options for {@link toolsListAvailable}. */
export interface ToolsAvailableOptions {
  /** Canonical language id filter (already canonicalized, e.g. `c++` → `cpp`), or undefined. */
  readonly lang?: string;
  /** Tool ids already installed (global or project), from the effective-set discovery. */
  readonly installedIds: ReadonlySet<string>;
  /** Injectable catalog for tests; defaults to the CLI-bundled one. */
  readonly catalog?: readonly FirstPartyAdapter[];
}

/** Options for the shared first-party adapter catalog selector. */
export interface AdapterSelectionOptions {
  /** Canonical language ids, undefined for no filter, or empty for polyglot-only. */
  readonly languages?: ReadonlySet<string>;
  /** Tool ids already installed (global or project), from the effective-set discovery. */
  readonly installedIds: ReadonlySet<string>;
  /** Injectable catalog for tests; defaults to the CLI-bundled one. */
  readonly catalog?: readonly FirstPartyAdapter[];
}

/** A polyglot adapter (`languages: []`) matches every language selection. */
function matchesLanguages(
  adapter: FirstPartyAdapter,
  languages: ReadonlySet<string> | undefined,
): boolean {
  if (languages === undefined) return true;
  if (adapter.languages.length === 0) return true;
  return adapter.languages.some((language) => languages.has(language));
}

/** Select and project adapter rows once, preserving generated catalog order. */
export function selectAvailableAdapters(
  options: AdapterSelectionOptions,
): readonly ToolsAvailableRow[] {
  const catalog = options.catalog ?? FIRST_PARTY_ADAPTERS;
  return catalog
    .filter((adapter) => matchesLanguages(adapter, options.languages))
    .map((adapter) => ({
      pkg: adapter.pkg,
      id: adapter.id,
      command: adapter.command,
      description: adapter.description,
      network: adapter.network,
      languages: adapter.languages,
      installed: options.installedIds.has(adapter.id),
    }));
}

export function toolsListAvailable(opts: ToolsAvailableOptions): ToolsAvailableResult {
  const adapters = selectAvailableAdapters({
    ...(opts.lang === undefined ? {} : { languages: new Set([opts.lang]) }),
    installedIds: opts.installedIds,
    ...(opts.catalog === undefined ? {} : { catalog: opts.catalog }),
  });
  return {
    type: 'tools-available',
    ...(opts.lang === undefined ? {} : { lang: opts.lang }),
    adapters,
    totalCount: adapters.length,
  };
}
