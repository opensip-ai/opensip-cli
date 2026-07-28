const REMOTE_URL = /^(?:https?:)?\/\//iu;
const REMOTE_CSS_REFERENCE =
  /(?:@import\s+(?:url\(\s*)?|url\(\s*)["']?((?:https?:)?\/\/[^\s"')]+)/giu;

const RESOURCE_ATTRIBUTES = [
  { selector: '[src]', attribute: 'src' },
  { selector: 'link[href]', attribute: 'href' },
  { selector: 'object[data]', attribute: 'data' },
] as const;

/**
 * Return remote URLs that the browser would load while rendering a report.
 *
 * Ordinary navigation links are deliberately excluded: an `<a href>` does
 * not make an offline report depend on the network. Resource-bearing
 * attributes, CSS imports/URLs, and srcset candidates do.
 */
export function findRemoteRenderDependencies(html: string): readonly string[] {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const dependencies = new Set<string>();

  for (const { selector, attribute } of RESOURCE_ATTRIBUTES) {
    for (const element of parsed.querySelectorAll(selector)) {
      const value = element.getAttribute(attribute)?.trim();
      if (value && REMOTE_URL.test(value)) dependencies.add(value);
    }
  }

  for (const element of parsed.querySelectorAll('[srcset]')) {
    const candidates = element.getAttribute('srcset')?.split(',') ?? [];
    for (const candidate of candidates) {
      const value = candidate.trim().split(/\s+/u)[0];
      if (value && REMOTE_URL.test(value)) dependencies.add(value);
    }
  }

  for (const style of parsed.querySelectorAll('style')) {
    for (const match of style.textContent?.matchAll(REMOTE_CSS_REFERENCE) ?? []) {
      const value = match[1];
      if (value) dependencies.add(value);
    }
  }

  return [...dependencies].sort();
}
