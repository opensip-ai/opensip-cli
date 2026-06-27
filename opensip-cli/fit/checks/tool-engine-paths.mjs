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

function escapeRe(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

const bundledToolSegmentAlternation = bundledToolPackageSegments.map(escapeRe).join('|');

export function toolEnginePathRe(suffix = '') {
  return new RegExp(`packages/(?:${bundledToolSegmentAlternation})/engine/src/${suffix}`);
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
  return new RegExp(`packages/(${bundledToolSegmentAlternation})/engine/src/`).exec(norm)?.[1];
}
