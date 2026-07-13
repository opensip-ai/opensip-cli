/** Infrastructure directories excluded from every target walk. */
export const COMMON_TARGET_IGNORE = Object.freeze([
  '**/node_modules/**',
  '**/dist/**',
  '**/.git/**',
]);
