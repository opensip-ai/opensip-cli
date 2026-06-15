/**
 * Offline-render guarantee for the Graph view.
 *
 * Playwright is not part of this package's toolchain, so rather than boot a
 * real browser this test asserts the offline property at the artifact
 * level: a generated report inlines the Cytoscape renderer and the
 * projected view-model with ZERO external `<script src>` references, so it
 * renders the Graph view with the network disabled ("open an archived
 * report on a plane"). The only permitted external reference is the Google
 * Fonts stylesheet `<link>` the report already carried before this work.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { generateDashboardHtml } from '../generator.js';

import type { GraphCatalog } from '@opensip-cli/contracts';

const HERE = dirname(fileURLToPath(import.meta.url));

function loadFixture(): GraphCatalog {
  const candidates = [
    join(HERE, 'fixtures', 'catalog-small.json'),
    join(HERE, '..', '..', 'src', '__tests__', 'fixtures', 'catalog-small.json'),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as GraphCatalog;
    } catch {
      // next
    }
  }
  throw new Error('catalog-small.json fixture not found');
}

describe('Graph view — offline render guarantee', () => {
  const html = generateDashboardHtml({ sessions: [], graphCatalog: loadFixture() });

  it('inlines the Cytoscape renderer (no CDN fetch)', () => {
    expect(html).toContain('cytoscape');
    expect(html).toContain('cytoscapeDagre');
  });

  it('embeds the projected graph-view-model blob', () => {
    expect(html).toContain('id="graph-view-model"');
  });

  it('registers the Graph view', () => {
    expect(html).toContain("id: 'graph'");
    expect(html).toContain('code-paths-graph-canvas');
  });

  it('has no external <script src> references (renders fully offline)', () => {
    const scriptSrc = /<script[^>]*\ssrc=["'][^"']+["']/gi;
    const matches = html.match(scriptSrc) ?? [];
    expect(matches).toHaveLength(0);
  });

  it('has no cytoscape CDN URL', () => {
    expect(/https?:\/\/[^"']*cytoscape/i.test(html)).toBe(false);
  });
});
