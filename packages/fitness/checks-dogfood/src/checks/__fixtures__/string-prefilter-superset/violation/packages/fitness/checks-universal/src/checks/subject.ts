const QUICK_FILTER_KEYWORDS = [': any', 'any)'];

export function analyze(content: string): string[] {
  if (!QUICK_FILTER_KEYWORDS.some((kw) => content.includes(kw))) return [];
  if (/Repository$/.test(content)) return ['repository'];
  return ['any'];
}
