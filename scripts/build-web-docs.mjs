#!/usr/bin/env node
//
// Build website-facing docs from docs/public/.
//
// The website at opensip.ai/docs/opensip-tools/ fetches Markdown files
// from this repo directly. Two things must differ between the in-repo
// view and the website view:
//
//   1. Source-code links — relative paths like ../../packages/foo.ts
//      need to become full GitHub URLs pinned to a stable ref so the
//      website's external links survive main-branch churn.
//
//   2. Sibling .md links — need to become root-relative website paths
//      (e.g. /docs/opensip-tools/80-implementation/01-cli-dispatch/) so
//      the website's internal navigation works.
//
// This script reads docs/public/**/*.md, applies those rewrites (and a
// few smaller ones), and writes the result to docs/web-generated/. The
// output is committed so the website needs no build-on-fetch logic and
// PR reviewers see exactly what will render.
//
// HTML comment markers let docs carry small voice differences between
// the two views:
//
//   <!-- web:skip -->...<!-- /web:skip -->   removed in the web view
//   <!-- web:only -->...<!-- /web:only -->   unwrapped in the web view
//
// Both are silent comments in the in-repo view.
//
// Usage:
//   node scripts/build-web-docs.mjs           # write docs/web-generated/
//   node scripts/build-web-docs.mjs --check   # exit 1 if docs/web-generated/ is stale
//

import { promises as fs } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------
// Config — edit when the website's URL scheme changes
// ---------------------------------------------------------------------

const REPO_OWNER = 'opensip-ai';
const REPO_NAME = 'opensip-tools';
const WEB_BASE_URL = '/docs/opensip-tools'; // root-relative on opensip.ai
const SOURCE_DOC_ROOT = 'docs/public';
const OUTPUT_DOC_ROOT = 'docs/web-generated';
const STRIP_MD_EXTENSION = true;
const TRAILING_SLASH = true;

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(__filename));

const CHECK_ONLY = process.argv.slice(2).includes('--check');

const main = async () => {
  const releaseRef = await readReleaseRef();
  log(`Source ref for code links: ${releaseRef}`);

  const sourceFiles = await collectMarkdownFiles(
    join(REPO_ROOT, SOURCE_DOC_ROOT)
  );
  log(`Source files: ${sourceFiles.length}`);

  const results = [];
  for (const srcAbs of sourceFiles) {
    const srcRel = relative(join(REPO_ROOT, SOURCE_DOC_ROOT), srcAbs)
      .split(sep)
      .join('/');
    const dstAbs = join(REPO_ROOT, OUTPUT_DOC_ROOT, srcRel);

    const source = await fs.readFile(srcAbs, 'utf8');
    const transformed = transformDoc(source, srcRel, releaseRef);
    results.push({ srcRel, dstAbs, transformed });
  }

  if (CHECK_ONLY) {
    const stale = [];
    for (const { srcRel, dstAbs, transformed } of results) {
      let existing = '';
      try {
        existing = await fs.readFile(dstAbs, 'utf8');
      } catch {
        // missing on disk — treat as stale
      }
      if (existing !== transformed) stale.push(srcRel);
    }

    // Manifest must also stay in sync. Deterministic build means a
    // straight string compare suffices.
    const expectedManifestText =
      JSON.stringify(buildManifest(results, releaseRef), null, 2) + '\n';
    const manifestPath = join(REPO_ROOT, OUTPUT_DOC_ROOT, 'manifest.json');
    let existingManifestText = '';
    try {
      existingManifestText = await fs.readFile(manifestPath, 'utf8');
    } catch {
      // missing — treat as stale
    }
    if (existingManifestText !== expectedManifestText) {
      stale.push('manifest.json');
    }

    // Also flag files in OUTPUT_DOC_ROOT that have no corresponding source
    const expectedDsts = new Set(results.map((r) => r.dstAbs));
    const actualDsts = (
      await collectMarkdownFiles(join(REPO_ROOT, OUTPUT_DOC_ROOT)).catch(
        () => []
      )
    );
    const orphaned = actualDsts.filter((p) => !expectedDsts.has(p));

    if (stale.length === 0 && orphaned.length === 0) {
      log(`${OUTPUT_DOC_ROOT}/ is in sync.`);
      return;
    }
    if (stale.length > 0) {
      err(`${OUTPUT_DOC_ROOT}/ is stale — ${stale.length} file(s) differ:`);
      for (const f of stale) err(`  - ${f}`);
    }
    if (orphaned.length > 0) {
      err(`${OUTPUT_DOC_ROOT}/ has ${orphaned.length} orphan file(s) (no source):`);
      for (const f of orphaned) {
        err(`  - ${relative(REPO_ROOT, f)}`);
      }
    }
    err('Run: node scripts/build-web-docs.mjs');
    process.exit(1);
  }

  // Write mode — clean output dir and write everything fresh
  await fs.rm(join(REPO_ROOT, OUTPUT_DOC_ROOT), {
    recursive: true,
    force: true,
  });
  for (const { dstAbs, transformed } of results) {
    await fs.mkdir(dirname(dstAbs), { recursive: true });
    await fs.writeFile(dstAbs, transformed);
  }

  // Manifest — single fetch on the website discovers every page.
  // The shape is intentionally small: enough for routing + nav, no
  // more. The website can fetch individual .md files for body content
  // and parse their frontmatter directly if it needs richer metadata.
  const manifest = buildManifest(results, releaseRef);
  await fs.writeFile(
    join(REPO_ROOT, OUTPUT_DOC_ROOT, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );

  log(`Wrote ${results.length} file(s) + manifest.json to ${OUTPUT_DOC_ROOT}/`);
};

// ---------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------

const buildManifest = (results, releaseRef) => {
  const pages = results.map(({ srcRel, transformed }) => {
    const fm = parseFrontmatter(transformed);
    return {
      file: `${OUTPUT_DOC_ROOT}/${srcRel}`,
      path: srcRelToWebPath(srcRel),
      section: srcRel.includes('/') ? srcRel.split('/')[0] : '',
      title: fm.title || filenameToTitle(srcRel),
      ...(fm.audience ? { audience: fm.audience } : {}),
      ...(fm.purpose ? { purpose: fm.purpose } : {}),
    };
  });

  // Sort: root README first, then by directory and filename
  pages.sort((a, b) => {
    if (a.file === `${OUTPUT_DOC_ROOT}/README.md`) return -1;
    if (b.file === `${OUTPUT_DOC_ROOT}/README.md`) return 1;
    return a.file.localeCompare(b.file);
  });

  // Group into sections for nav.
  const sectionMap = new Map();
  for (const page of pages) {
    if (!page.section) continue;
    if (!sectionMap.has(page.section)) {
      sectionMap.set(page.section, {
        section: page.section,
        title: sectionTitle(page.section),
        pages: [],
      });
    }
    sectionMap.get(page.section).pages.push(page.path);
  }
  const nav = [...sectionMap.values()];

  // Audience-tab grouping — derived from per-page `audience:` frontmatter.
  // The website can use this to render audience-tabbed navigation as an
  // alternative to the numeric section ladder. Each page can appear in
  // multiple tabs; the ordering of tabs is stable + curated below.
  const audienceTabs = buildAudienceTabs(pages);

  // No build timestamp on purpose — manifest is fully deterministic so
  // re-running the build never produces a spurious diff. The website
  // can derive "last updated" from the GitHub commit timestamp via API.
  return {
    version: releaseRef.replace(/^v/, ''),
    rawBase: `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${releaseRef}/`,
    pages,
    nav,
    audienceTabs,
  };
};

// Audience tabs — derived nav grouping. Order + display titles are
// curated; tags that don't appear here are silently grouped under
// "Other" so a new tag added in frontmatter shows up without breaking
// the build. The website is expected to render these as top-level tabs;
// pages within a tab follow `pages` array order (i.e. filesystem order).
const AUDIENCE_TAB_ORDER = [
  { tag: 'getting-started', title: 'Start' },
  { tag: 'plugin-authors',  title: 'Author plugins' },
  { tag: 'ci-integrators',  title: 'Integrate with CI' },
  { tag: 'contributors',    title: 'Contribute' },
];

const buildAudienceTabs = (pages) => {
  const tabs = AUDIENCE_TAB_ORDER.map(({ tag, title }) => ({
    audience: tag,
    title,
    pages: [],
  }));
  const otherPages = [];
  const tabIndex = new Map(tabs.map((t, i) => [t.audience, i]));

  for (const page of pages) {
    const audience = Array.isArray(page.audience) ? page.audience : [];
    if (audience.length === 0) {
      // No frontmatter audience — surface under all tabs would be noisy;
      // surface under "contributors" by convention (these are typically
      // architecture or convention pages).
      tabs[tabIndex.get('contributors')].pages.push(page.path);
      continue;
    }
    let placed = false;
    for (const a of audience) {
      if (tabIndex.has(a)) {
        tabs[tabIndex.get(a)].pages.push(page.path);
        placed = true;
      }
    }
    if (!placed) {
      otherPages.push(page.path);
    }
  }

  if (otherPages.length > 0) {
    tabs.push({ audience: 'other', title: 'Other', pages: otherPages });
  }

  // Strip empty tabs — a tab with zero pages is noise in the website nav.
  return tabs.filter((t) => t.pages.length > 0);
};

const parseFrontmatter = (text) => {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out = {};
  const lines = match[1].split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Inline JSON-ish arrays — best-effort
    if (value.startsWith('[') && value.endsWith(']')) {
      try {
        // Convert YAML inline array to JSON: single-quoted -> double, no quotes around bare words
        const jsonish = value.replace(/'/g, '"').replace(/([A-Za-z_-][\w-]*)/g, (m) =>
          /^(true|false|null)$/.test(m) ? m : `"${m}"`
        );
        out[key] = JSON.parse(jsonish);
        continue;
      } catch {
        // fall through, store as raw string
      }
    }
    out[key] = value;
  }
  return out;
};

const srcRelToWebPath = (srcRel) => {
  // Mirror the link-rewriting logic so manifest paths match what
  // rewritten links inside other docs point to.
  if (srcRel === 'README.md') {
    return WEB_BASE_URL + (TRAILING_SLASH ? '/' : '');
  }
  if (srcRel.endsWith('/README.md')) {
    const dir = srcRel.slice(0, -'/README.md'.length);
    return `${WEB_BASE_URL}/${dir}${TRAILING_SLASH ? '/' : ''}`;
  }
  let path = srcRel;
  if (STRIP_MD_EXTENSION && path.endsWith('.md')) {
    path = path.slice(0, -3);
  }
  return `${WEB_BASE_URL}/${path}${TRAILING_SLASH ? '/' : ''}`;
};

const filenameToTitle = (srcRel) => {
  const base = srcRel.split('/').pop().replace(/\.md$/, '');
  // Drop leading numeric prefix like "00-" or "10-"
  const stripped = base.replace(/^\d+[-_]/, '');
  return stripped
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
};

const sectionTitle = (section) => {
  // "00-orientation" → "00 — Orientation"
  const m = section.match(/^(\d+)[-_](.+)$/);
  if (!m) return section;
  const num = m[1];
  const rest = m[2]
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return `${num} — ${rest}`;
};

// ---------------------------------------------------------------------
// Source helpers
// ---------------------------------------------------------------------

const readReleaseRef = async () => {
  const pkg = JSON.parse(
    await fs.readFile(
      join(REPO_ROOT, 'packages/core/package.json'),
      'utf8'
    )
  );
  return `v${pkg.version}`;
};

const collectMarkdownFiles = async (dir) => {
  const out = [];
  const walk = async (d) => {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const ent of entries) {
      const full = join(d, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile() && ent.name.endsWith('.md')) out.push(full);
    }
  };
  await walk(dir);
  return out;
};

// ---------------------------------------------------------------------
// Transform pipeline
// ---------------------------------------------------------------------

const transformDoc = (source, srcRel, releaseRef) => {
  let text = source;
  text = applyWebMarkers(text);
  text = rewriteLinks(text, srcRel, releaseRef);
  text = warnIfMermaid(text, srcRel);
  return text;
};

const applyWebMarkers = (text) => {
  // Remove web:skip blocks entirely
  text = text.replace(
    /<!--\s*web:skip\s*-->[\s\S]*?<!--\s*\/web:skip\s*-->\n?/g,
    ''
  );
  // Unwrap web:only blocks (keep content, drop markers)
  text = text.replace(
    /<!--\s*web:only\s*-->\n?([\s\S]*?)\n?<!--\s*\/web:only\s*-->\n?/g,
    '$1'
  );
  return text;
};

const rewriteLinks = (text, srcRel, releaseRef) => {
  const lines = text.split('\n');
  let inFence = false;
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return rewriteLineLinks(line, srcRel, releaseRef);
    })
    .join('\n');
};

const rewriteLineLinks = (line, srcRel, releaseRef) => {
  // Match Markdown link syntax: [label](target).
  // Captures label (preserving square brackets) and target.
  return line.replace(/(\[[^\]]+\])\(([^)]+)\)/g, (match, label, target) => {
    const newTarget = rewriteTarget(target.trim(), srcRel, releaseRef);
    return `${label}(${newTarget})`;
  });
};

const rewriteTarget = (target, srcRel, releaseRef) => {
  // External URLs, anchors, mailto — leave alone
  if (/^(?:[a-z][a-z+\-.]*:|#|\/\/)/.test(target)) return target;
  if (target === '') return target;

  // Split off anchor and any trailing query (we ignore queries for now)
  const hashIdx = target.indexOf('#');
  const pathPart = hashIdx >= 0 ? target.slice(0, hashIdx) : target;
  const anchor = hashIdx >= 0 ? target.slice(hashIdx) : '';

  if (pathPart === '') return target; // pure anchor link, already handled above

  // Resolve relative to the source file's directory under SOURCE_DOC_ROOT
  const srcDir = posix.dirname(`${SOURCE_DOC_ROOT}/${srcRel}`);
  const resolved = posix.normalize(posix.join(srcDir, pathPart));

  if (
    resolved === SOURCE_DOC_ROOT ||
    resolved.startsWith(`${SOURCE_DOC_ROOT}/`)
  ) {
    return rewriteToWebsitePath(resolved, anchor);
  }
  return rewriteToGithubUrl(resolved, anchor, releaseRef);
};

const rewriteToWebsitePath = (resolvedFromRepoRoot, anchor) => {
  let underRoot = resolvedFromRepoRoot.slice(`${SOURCE_DOC_ROOT}/`.length);

  // README.md at any level → directory index
  if (underRoot === '' || underRoot === 'README.md') {
    return joinAnchor(WEB_BASE_URL + (TRAILING_SLASH ? '/' : ''), anchor);
  }
  if (underRoot.endsWith('/README.md')) {
    underRoot = underRoot.slice(0, -'/README.md'.length);
    return joinAnchor(
      `${WEB_BASE_URL}/${underRoot}${TRAILING_SLASH ? '/' : ''}`,
      anchor
    );
  }
  if (STRIP_MD_EXTENSION && underRoot.endsWith('.md')) {
    underRoot = underRoot.slice(0, -3);
  }
  // Normalize trailing slash on directory-style links so we never emit "//"
  if (underRoot.endsWith('/')) {
    underRoot = underRoot.slice(0, -1);
  }
  return joinAnchor(
    `${WEB_BASE_URL}/${underRoot}${TRAILING_SLASH ? '/' : ''}`,
    anchor
  );
};

const rewriteToGithubUrl = (resolvedFromRepoRoot, anchor, releaseRef) =>
  joinAnchor(
    `https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/${releaseRef}/${resolvedFromRepoRoot}`,
    anchor
  );

const joinAnchor = (path, anchor) => (anchor ? `${path}${anchor}` : path);

const warnIfMermaid = (text, srcRel) => {
  // SVG pre-rendering for mermaid blocks is not yet wired. When the
  // first mermaid block is added, integrate @mermaid-js/mermaid-cli
  // here: convert each fenced ```mermaid block to an SVG written to
  // docs/web-generated/diagrams/<hash>.svg and replace the block with an <img>.
  if (/```mermaid/.test(text)) {
    err(
      `warn: ${srcRel} contains a mermaid block — SVG pre-rendering not yet wired; leaving block as-is. See scripts/build-web-docs.mjs:warnIfMermaid().`
    );
  }
  return text;
};

const log = (msg) => console.error(`[build-web-docs] ${msg}`);
const err = (msg) => console.error(`[build-web-docs] ${msg}`);

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
