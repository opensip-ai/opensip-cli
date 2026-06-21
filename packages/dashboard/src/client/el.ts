/**
 * `el(tag, attrs, children)` — tiny DOM-builder helper used everywhere a string
 * of `document.createElement` + setAttribute calls would otherwise live.
 *
 * Special attribute keys: `text` sets `textContent`, `class` sets `className`,
 * anything starting with `on` is treated as an event listener (e.g. `onclick`),
 * everything else passes through to `setAttribute`. `children` may include strings
 * (auto-wrapped into text nodes) or `null`/`undefined` (skipped).
 *
 * First module migrated out of the legacy String.raw emitters (L4): real,
 * type-checked TypeScript (DOM lib) bundled into the inlined client `<script>`.
 */

type ElAttrs = Record<string, unknown>;
type ElChild = Node | string | null | undefined;

export function el(tag: string, attrs?: ElAttrs, children?: readonly ElChild[]): HTMLElement {
  const e = document.createElement(tag);
  if (attrs)
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'text') e.textContent = v as string;
      else if (k === 'class') e.className = v as string;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v as EventListener);
      else e.setAttribute(k, v as string);
    });
  if (children)
    children.forEach((c) => {
      // `append(string)` creates a text node — identical to the prior
      // appendChild(createTextNode(...)); `append(node)` appends the node. Skip
      // null/undefined; an empty string '' is still appended (as before).
      if (typeof c === 'string' || c) e.append(c);
    });
  return e;
}
