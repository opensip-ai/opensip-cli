import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifestUrl = new URL(
  '../../../packages/cli/src/bootstrap/bundled-tools.manifest.json',
  import.meta.url,
);

const manifest = JSON.parse(readFileSync(fileURLToPath(manifestUrl), 'utf8'));

export const bundledToolPackageSegments = Object.freeze(
  [...(manifest.bundledPackages ?? [])]
    .map((name) => /^@opensip-cli\/([^/]+)$/.exec(name)?.[1])
    .filter((segment) => typeof segment === 'string' && segment.length > 0),
);

// ADR-0090 adapter/scanner packages are tool-shaped, but their production code
// lives directly under package-root src/ rather than <tool>/engine/src/.
const adr0090AdapterPackageSegments = Object.freeze([
  'external-tool-adapter',
  'tool-gitleaks',
  'tool-osv-scanner',
  'tool-trivy',
]);

export const toolSeamPackageSegments = Object.freeze([
  ...bundledToolPackageSegments,
  ...adr0090AdapterPackageSegments,
]);

function escapeRe(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

const bundledToolSegmentAlternation = bundledToolPackageSegments.map(escapeRe).join('|');
const bundledToolEngineRoots = bundledToolPackageSegments.map((segment) =>
  segment === 'mcp' ? 'packages/mcp/src/' : `packages/${segment}/engine/src/`,
);
const bundledToolEngineRootAlternation = bundledToolEngineRoots.map(escapeRe).join('|');
const adapterToolRoots = adr0090AdapterPackageSegments.map((segment) => `packages/${segment}/src/`);
const toolSeamRootAlternation = [...bundledToolEngineRoots, ...adapterToolRoots]
  .map(escapeRe)
  .join('|');

export function toolEnginePathRe(suffix = '') {
  return new RegExp(`(?:${bundledToolEngineRootAlternation})${suffix}`);
}

export function toolSeamPathRe(suffix = '') {
  return new RegExp(`(?:${toolSeamRootAlternation})${suffix}`);
}

export function toolEngineCliPathRe(suffix = '') {
  return toolEnginePathRe(`cli/${suffix}`);
}

export function toolDescriptorPathRe() {
  return toolEnginePathRe('tool\\.ts$');
}

export function toolPackagePathRe(suffix = '') {
  return new RegExp(`packages/(?:${bundledToolSegmentAlternation})/${suffix}`);
}

export function toolPackageSegmentForPath(filePath) {
  const norm = String(filePath).replaceAll('\\', '/');
  if (/packages\/mcp\/src\//.test(norm)) return 'mcp';
  return new RegExp(`packages/(${bundledToolSegmentAlternation})/engine/src/`).exec(norm)?.[1];
}
