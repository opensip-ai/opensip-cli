---
status: current
last_verified: 2026-06-07
release: v3.0.0
title: "Website integration — opensip.ai"
audience: [contributors]
purpose: "How opensip.ai consumes docs/web-generated/ from this repo: backend proxy, frontend route, manifest contract."
related-docs:
  - ../../../scripts/build-web-docs.mjs
---
# Website integration — opensip.ai

`docs/web-generated/` in this repo is generated, deterministic, and committed. The website at opensip.ai fetches those files from GitHub at runtime — no build coupling between the two repos. This document is the contract.

The website is **Vite + React + Wouter** on the frontend, **Express + TypeScript** on the backend, **PostgreSQL + Drizzle** for state. All code samples assume that stack.

---

## CLI installer endpoint

The customer-facing install command is:

```bash
curl -fsSL https://opensip.ai/cli/install.sh | bash
```

The canonical script lives in this repo at `scripts/install.sh`. The website
should expose `/cli/install.sh` as a stable branded URL and either redirect or
proxy to:

```
https://raw.githubusercontent.com/opensip-ai/opensip-cli/main/scripts/install.sh
```

For a Replit/Express site, the smallest route is:

```ts
app.get('/cli/install.sh', (_req, res) => {
  res.redirect(
    302,
    'https://raw.githubusercontent.com/opensip-ai/opensip-cli/main/scripts/install.sh',
  );
});
```

If you prefer to avoid a client-visible redirect, proxy the GitHub response and
set `Content-Type: text/x-shellscript; charset=utf-8`. In both cases,
`opensip.ai/cli/install.sh` is the public contract; the GitHub raw URL is only
the implementation detail.

---

## The manifest contract

The single entry point is `docs/web-generated/manifest.json`. Fetch it from:

```
https://raw.githubusercontent.com/opensip-ai/opensip-cli/main/docs/web-generated/manifest.json
```

Shape:

```ts
type DocManifest = {
  version: string;       // e.g. "1.0.4" — the opensip-cli release this docset matches
  rawBase: string;       // e.g. "https://raw.githubusercontent.com/opensip-ai/opensip-cli/v1.0.4/"
  pages: DocPage[];
  nav: NavSection[];
};

type DocPage = {
  file: string;          // 'docs/web-generated/00-start/00-quick-start.md'
  path: string;          // '/docs/opensip-cli/00-start/00-quick-start/'
  section: string;       // '00-start' (empty string for root README)
  title: string;
  audience?: string[];
  purpose?: string;
};

type NavSection = {
  section: string;       // '00-start'
  title: string;         // '00 — Start'
  pages: string[];       // array of page.path values
};
```

Per-page markdown is at `${rawBase}${page.file}`. Frontmatter is YAML; the body is GitHub-flavored markdown. The build script's link rewriter has already turned source-code references into full `github.com/...` URLs and sibling `.md` links into root-relative website paths.

`rawBase` pins to the **release tag** of opensip-cli, not `main`. The website's docs always match a released version of the CLI — you never see a half-merged-mid-release state. When opensip-cli bumps versions, the manifest's `rawBase` updates automatically and the website picks up the new release on the next cache refresh.

---

## Backend — Express proxy with TTL cache

`server/routes/docs.ts`:

```ts
import { Router } from 'express';
import matter from 'gray-matter';

const router = Router();

const MANIFEST_URL =
  'https://raw.githubusercontent.com/opensip-ai/opensip-cli/main/docs/web-generated/manifest.json';
const TTL_MS = 5 * 60 * 1000;  // 5-minute cache

type Cached<T> = { value: T; expiresAt: number };
const manifestCache: { current: Cached<DocManifest> | null } = { current: null };
const pageCache = new Map<string, Cached<{ frontmatter: Record<string, unknown>; body: string }>>();

const isFresh = (c: Cached<unknown> | null | undefined) =>
  c != null && c.expiresAt > Date.now();

const fetchManifest = async (): Promise<DocManifest> => {
  if (isFresh(manifestCache.current)) return manifestCache.current!.value;
  const res = await fetch(MANIFEST_URL);
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
  const value = (await res.json()) as DocManifest;
  manifestCache.current = { value, expiresAt: Date.now() + TTL_MS };
  return value;
};

const fetchPage = async (manifest: DocManifest, page: DocPage) => {
  const cached = pageCache.get(page.file);
  if (isFresh(cached)) return cached!.value;
  const res = await fetch(`${manifest.rawBase}${page.file}`);
  if (!res.ok) throw new Error(`page fetch failed: ${res.status}`);
  const raw = await res.text();
  const { data: frontmatter, content: body } = matter(raw);
  const value = { frontmatter, body };
  pageCache.set(page.file, { value, expiresAt: Date.now() + TTL_MS });
  return value;
};

router.get('/manifest', async (_req, res, next) => {
  try {
    const manifest = await fetchManifest();
    res.set('Cache-Control', 'public, max-age=300');
    res.json(manifest);
  } catch (e) {
    next(e);
  }
});

router.get('/page', async (req, res, next) => {
  try {
    const path = String(req.query.path ?? '');
    if (!path.startsWith('/docs/opensip-cli/')) {
      return res.status(400).json({ error: 'invalid path' });
    }
    const manifest = await fetchManifest();
    const page = manifest.pages.find((p) => p.path === path);
    if (!page) return res.status(404).json({ error: 'page not found' });
    const content = await fetchPage(manifest, page);
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ page, ...content });
  } catch (e) {
    next(e);
  }
});

export default router;

// Type re-declarations — keep in a shared types file in production
type DocPage = { file: string; path: string; section: string; title: string; audience?: string[]; purpose?: string };
type NavSection = { section: string; title: string; pages: string[] };
type DocManifest = { version: string; rawBase: string; pages: DocPage[]; nav: NavSection[] };
```

Mount it in your main Express setup:

```ts
import docsRouter from './routes/docs';
app.use('/api/docs', docsRouter);
```

Dependencies: `gray-matter` (for frontmatter parsing). The `fetch` built-in is available in Node 18+.

### Cache invalidation

The 5-minute TTL is the default freshness window. Two ways to go tighter if it matters:

- **GitHub webhook** — opensip-cli fires a webhook on every push to main; your Express receives it and clears `manifestCache.current` and `pageCache`. Adds ~10 lines and a webhook secret to manage.
- **Just lower TTL** — `TTL_MS = 60_000` (1 minute) is fine for the GitHub raw endpoints' rate limits if your docs traffic is modest.

For longer-term resilience: replace the in-memory `Map` with a PostgreSQL table via Drizzle. Doesn't change the contract, just the storage. Useful if you have multiple Express instances behind a load balancer.

---

## Frontend — Wouter route + React component

`client/src/lib/docs.ts`:

```ts
export type DocPage = {
  file: string;
  path: string;
  section: string;
  title: string;
  audience?: string[];
  purpose?: string;
};

export type DocManifest = {
  version: string;
  rawBase: string;
  pages: DocPage[];
  nav: { section: string; title: string; pages: string[] }[];
};

export const fetchManifest = async (): Promise<DocManifest> => {
  const res = await fetch('/api/docs/manifest');
  if (!res.ok) throw new Error('failed to load docs manifest');
  return res.json();
};

export const fetchPage = async (path: string) => {
  const res = await fetch(`/api/docs/page?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error('failed to load doc page');
  return res.json() as Promise<{
    page: DocPage;
    frontmatter: Record<string, unknown>;
    body: string;
  }>;
};
```

`client/src/pages/DocsOpensipTools.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fetchPage } from '@/lib/docs';
import { DocsNav } from '@/components/DocsNav';

export function DocsOpensipTools() {
  const [location] = useLocation();
  const [body, setBody] = useState<string | null>(null);
  const [title, setTitle] = useState<string>('Loading…');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Wouter gives us location without trailing slash; manifest paths
    // always have trailing slash. Normalize.
    const path = location.endsWith('/') ? location : `${location}/`;
    setBody(null);
    setError(null);
    fetchPage(path)
      .then((data) => {
        setTitle(data.page.title);
        setBody(data.body);
        document.title = `${data.page.title} · OpenSIP CLI`;
      })
      .catch((e) => setError(e.message));
  }, [location]);

  return (
    <div className="flex gap-8">
      <aside className="w-64 shrink-0">
        <DocsNav />
      </aside>
      <article className="prose flex-1">
        <h1>{title}</h1>
        {error && <p className="text-red-500">Failed to load: {error}</p>}
        {!error && body === null && <p>Loading…</p>}
        {body && <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>}
      </article>
    </div>
  );
}
```

`client/src/components/DocsNav.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { fetchManifest, type DocManifest } from '@/lib/docs';

export function DocsNav() {
  const [manifest, setManifest] = useState<DocManifest | null>(null);
  const [location] = useLocation();

  useEffect(() => {
    fetchManifest().then(setManifest);
  }, []);

  if (!manifest) return null;

  return (
    <nav className="space-y-6 text-sm">
      {manifest.nav.map((section) => (
        <div key={section.section}>
          <h3 className="font-semibold mb-2">{section.title}</h3>
          <ul className="space-y-1">
            {section.pages.map((path) => {
              const page = manifest.pages.find((p) => p.path === path);
              if (!page) return null;
              const isActive = location === path.replace(/\/$/, '');
              return (
                <li key={path}>
                  <Link
                    href={path}
                    className={isActive ? 'font-medium' : 'text-gray-600 hover:text-gray-900'}
                  >
                    {page.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
```

Register the route in your top-level router:

```tsx
import { Route } from 'wouter';
import { DocsOpensipTools } from '@/pages/DocsOpensipTools';

<Route path="/docs/opensip-cli/:rest*" component={DocsOpensipTools} />
```

Dependencies to add: `react-markdown`, `remark-gfm`.

---

## Styling

For markdown body styling, the easiest path with Tailwind is `@tailwindcss/typography`:

```bash
Add `@tailwindcss/typography` as a dev dependency.
```

In `tailwind.config.js`:

```js
module.exports = {
  // ...
  plugins: [require('@tailwindcss/typography')],
};
```

Wrap markdown body in `<article className="prose">` and you get a sensible default typography style for headings, code blocks, lists, and tables.

---

## SEO

Vite + React renders client-side, which Googlebot handles (it executes JS) but is slower to index than SSR. For docs pages this is usually acceptable. If SEO matters more, two upgrade paths:

1. **Express middleware that serves prerendered HTML to crawlers**. Detect Googlebot/Bingbot via user-agent; for those requests, fetch the manifest+page server-side and inline the body into the initial HTML response. For everyone else, serve the standard SPA shell.

2. **Move docs rendering fully into Express** — return a server-rendered HTML page at `/docs/opensip-cli/*` paths, bypassing React entirely for that route. Most SEO-friendly but doubles the rendering surface.

Start with plain CSR; upgrade only if Google indexing latency is hurting acquisition.

---

## Deployment notes (Replit)

- **Autoscale deployment** is the right pick (not Reserved VM). The Express backend and Vite-built static assets fit cleanly.
- **Build command**: `npm run build` (your existing Vite + Express build).
- **Start command**: `npm run start` (your existing Express entry).
- **Environment variables**: none required for the docs integration — everything fetches public GitHub.
- **Cache directory**: Express's in-memory cache resets on every deploy/restart. Acceptable for docs. If you want cross-restart caching, move the cache to PostgreSQL via Drizzle (small migration: a `docs_cache` table keyed by URL, value = JSON, expires_at timestamp).

---

## Adding new docs

The contract is: every time `docs/web-generated/manifest.json` in opensip-cli updates, the website picks up the changes within the 5-minute TTL window. No deployment of opensip.ai is needed for new docs.

In opensip:
1. Edit `docs/public/*.md`
2. `pnpm docs:build` regenerates `docs/web-generated/` (including manifest)
3. Commit and push

The CI sync check ensures `docs/web-generated/` never drifts from `docs/public/`.
