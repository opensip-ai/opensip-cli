export const BASE_PROJECT_SOURCE = [
  'export function main(): number { return helper(); }',
  'export function helper(): number { return 1; }',
  'export function unused(): number { return 7; }',
  'export function entry(): number { return main(); }',
  '',
].join('\n');

/** Build a deterministic source file with many direct callers of `helper`. */
export function highFanInProjectSource(callers = 2100): string {
  const declarations = Array.from(
    { length: callers },
    (_, index) => `export function caller${String(index)}(): number { return helper(); }`,
  );
  return `${BASE_PROJECT_SOURCE}${declarations.join('\n')}\n`;
}
