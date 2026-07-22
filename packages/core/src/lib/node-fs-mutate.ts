/**
 * @fileoverview Re-export of `node:fs`'s mutating fd-lifecycle surface
 * (open/close/write/link/rename/unlink + permission bits) used by
 * `runtime-lease.ts`.
 *
 * `runtime-lease.ts` needs 18 total `node:fs` sync bindings — more than fit
 * in one import statement under the `heavy-import-detection` named-import
 * limit (15). A single file also cannot hold two separate `import … from
 * 'node:fs'` statements (`import-x/no-duplicates`), so the 18 names are
 * partitioned by purpose across this module and the sibling
 * `node-fs-inspect.ts` module instead of split within one file.
 */
export {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
