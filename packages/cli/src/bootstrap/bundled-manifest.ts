import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Data-driven source for first-party bundled tools and capability packs.
 * Loaded via fs + import.meta.url (works in src dev and dist/ after build copy).
 */
const manifestUrl = new URL('bundled-tools.manifest.json', import.meta.url);
const bundledManifest = JSON.parse(readFileSync(fileURLToPath(manifestUrl), 'utf8')) as {
  bundledPackages: readonly string[];
  scaffoldingToolIds: readonly string[];
  bundledCapabilityPacks?: Readonly<Record<string, readonly string[]>>;
};

export const BUNDLED_TOOL_PACKAGES: readonly string[] = bundledManifest.bundledPackages;

export const EXPECTED_SCAFFOLDING_TOOL_IDS: readonly string[] = bundledManifest.scaffoldingToolIds;

/** Bundled capability pack npm names keyed by marker kind / domain id. */
export const BUNDLED_CAPABILITY_PACKS: Readonly<Record<string, readonly string[]>> =
  bundledManifest.bundledCapabilityPacks ?? {};
