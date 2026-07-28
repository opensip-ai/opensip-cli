/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Fast artifact-level proof for the offline Graph-view contract. This file is
 * intentionally part of the ordinary package lane; the separate integration
 * file is reserved for the post-build real-CLI workflow.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { generateDashboardHtml } from '../generator.js';

import { findRemoteRenderDependencies } from './offline-resource-references.js';

import type { GraphCatalog } from '@opensip-cli/contracts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REMOTE_ASSET_CDN =
  /https?:\/\/(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|cdn\.skypack\.dev)\//iu;

function loadFixture(): GraphCatalog {
  return JSON.parse(
    readFileSync(join(HERE, 'fixtures', 'catalog-small.json'), 'utf8'),
  ) as GraphCatalog;
}

describe('Graph view — offline render guarantee', () => {
  const html = generateDashboardHtml({
    sessions: [],
    graphCatalog: loadFixture(),
  });

  it('inlines the Cytoscape renderer and projected graph model', () => {
    expect(html).toContain('cytoscape');
    expect(html).toContain('cytoscapeDagre');
    expect(html).toContain('id="graph-view-model"');
  });

  it('registers the Graph view', () => {
    // The view registers from the typed client bundle (L4) — esbuild emits
    // double-quoted object keys/values, so the marker is the bundled form.
    expect(html).toContain('id: "graph"');
    expect(html).toContain('code-paths-graph-canvas');
  });

  it('has no remote render dependencies or network-loading APIs', () => {
    expect(findRemoteRenderDependencies(html)).toEqual([]);
    expect(html).not.toMatch(REMOTE_ASSET_CDN);
    expect(html).not.toMatch(/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)\b/u);
    expect(html).not.toMatch(/\bimport\s*\(\s*["']https?:\/\//u);
  });

  it('distinguishes navigation links from remote render dependencies', () => {
    const dependencies = findRemoteRenderDependencies(`
      <a href="https://opensip.ai">navigation is inert until clicked</a>
      <script src="https://cdn.example.test/cytoscape.js"></script>
      <link rel="stylesheet" href="//cdn.example.test/report.css">
      <style>.remote { background: url('https://cdn.example.test/background.png'); }</style>
    `);

    expect(dependencies).toEqual([
      '//cdn.example.test/report.css',
      'https://cdn.example.test/background.png',
      'https://cdn.example.test/cytoscape.js',
    ]);
  });
});
