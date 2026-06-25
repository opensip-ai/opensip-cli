/**
 * Report cup mark — two renderings of the OpenSIP coffee cup, both faithful to
 * opensip.ai:
 *   - FAVICON: a geometric SVG (browser tabs require an image), byte-matching
 *     the shapes in opensip.ai/favicon.svg.
 *   - HEADER: the CLI `BANNER_MINI_CUP` ASCII art rendered as styled monospace
 *     `<pre>` text — exactly the site header `CoffeeLogo` component.
 */

/** Geometric favicon geometry (32×32 viewBox), matching opensip.ai/favicon.svg. */
const REPORT_CUP_SVG_INNER = `<circle cx="11" cy="3" r="1.8" fill="#e8e4df"/><circle cx="20" cy="3" r="1.8" fill="#e8e4df"/><rect x="3" y="7" width="26" height="8" rx="1" fill="#d8d4ce"/><rect x="3" y="16" width="26" height="9" fill="#C8956C"/><rect x="7" y="26" width="18" height="4" rx="1" fill="#C8956C"/>`;

const REPORT_CUP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${REPORT_CUP_SVG_INNER}</svg>`;

/** Data URI for `<link rel="icon" type="image/svg+xml" href="…">`. */
export const REPORT_CUP_FAVICON_DATA_URI = `data:image/svg+xml,${encodeURIComponent(REPORT_CUP_SVG)}`;

/** CLI mini-cup ASCII art (`BANNER_MINI_CUP`): steam `⋮ ⋮`, lid, body, saucer. */
const MINI_CUP = [' ⋮ ⋮ ', '▟███▙', '▐███▌', ' ▀▀▀ '];
/** Rows 0–1 (steam + lid) render near-white; rows 2–3 (body + saucer) brand amber. */
const MINI_CUP_LIGHT_ROWS = new Set([0, 1]);
const MINI_CUP_LIGHT = '#f5f5f5';
const MINI_CUP_BRAND = '#C8956C';
const MINI_CUP_PRE_STYLE =
  "font-family:ui-monospace,'Cascadia Code','SF Mono',Menlo,Consolas,monospace;" +
  'font-size:8px;line-height:1.1;margin:0;padding:0;user-select:none;';

/**
 * Inline header mark — the site `CoffeeLogo`: `BANNER_MINI_CUP` rendered as
 * styled monospace text. `<pre>` preserves the art's exact spacing; row 0 gets a
 * small left pad to recenter the narrower `⋮` steam glyphs (per opensip.ai).
 */
export const REPORT_CUP_HEADER_HTML = `<pre aria-hidden="true" style="${MINI_CUP_PRE_STYLE}">${MINI_CUP.map(
  (line, i) =>
    `<span style="color:${MINI_CUP_LIGHT_ROWS.has(i) ? MINI_CUP_LIGHT : MINI_CUP_BRAND};display:block;${
      i === 0 ? 'padding-left:0.15em;' : ''
    }">${line}</span>`,
).join('')}</pre>`;
