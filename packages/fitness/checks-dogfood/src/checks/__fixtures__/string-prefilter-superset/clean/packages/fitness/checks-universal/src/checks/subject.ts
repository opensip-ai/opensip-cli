const QUICK_FILTER_SUBSTRING = 'any';
const REPOSITORY_NAME = /Repository$/;

export function analyze(content: string, className: string): string[] {
  if (!content.includes(QUICK_FILTER_SUBSTRING)) return [];
  if (REPOSITORY_NAME.test(className)) return ['repository'];
  return ['any'];
}
