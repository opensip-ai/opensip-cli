/**
 * Re-export of the hashing / value-normalization helpers from the authored-plan
 * types module. Split into this thin companion so a single consumer can import
 * the plan's full helper set across two modules without tripping the
 * heavy-import-detection threshold (and without duplicate same-module imports,
 * which `import-x/no-duplicates` forbids).
 */
export {
  caseFoldPath,
  compareUtf8,
  normalizeLanguages,
  normalizeProjectRelativePath,
  normalizeToolIdentities,
  sha256Bytes,
  sha256Parts,
} from './init-authored-plan-types.js';
