// Clean: the host imports a tool package's NON-runtime API (graph's
// adapter-discovery, fitness's authoring API) — legitimate couplings, not the
// runtime-load privilege. No tool-runtime symbol is imported, so this is clean.
import { defineCheck } from '@opensip-cli/fitness';
import { discoverGraphAdapterPackages } from '@opensip-cli/graph';

export const check = defineCheck;
export const discover = discoverGraphAdapterPackages;
