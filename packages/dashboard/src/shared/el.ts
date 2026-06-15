/**
 * `el(tag, attrs, children)` — tiny DOM-builder helper used everywhere
 * a string of `document.createElement` + setAttribute calls would
 * otherwise live.
 *
 * Special attribute keys: `text` sets `textContent`, `class` sets
 * `className`, anything starting with `on` is treated as an event
 * listener (e.g. `onclick`), everything else passes through to
 * `setAttribute`. `children` may include strings (auto-wrapped into
 * text nodes) or `null`/`undefined` (skipped).
 */
export function dashboardElJs(): string {
  return String.raw`
function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) Object.entries(attrs).forEach(([k,v]) => {
    if (k === 'text') e.textContent = v;
    else if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  });
  if (children) children.forEach(c => { if (typeof c === 'string') e.appendChild(document.createTextNode(c)); else if (c) e.appendChild(c); });
  return e;
}
`;
}
