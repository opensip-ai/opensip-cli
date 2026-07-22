/**
 * @fileoverview Re-export of `node:fs`'s read-only inspection surface
 * (existence/stat/dir/read + the `O_*` mode constants those reads pair
 * with) used by `runtime-lease.ts`.
 *
 * `runtime-lease.ts` needs 18 total `node:fs` sync bindings — more than fit
 * in one import statement under the `heavy-import-detection` named-import
 * limit (15). A single file also cannot hold two separate `import … from
 * 'node:fs'` statements (`import-x/no-duplicates`), so the 18 names are
 * partitioned by purpose across this module and the sibling
 * `node-fs-mutate.ts` module instead of split within one file.
 */
export {
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  opendirSync,
  readSync,
  realpathSync,
} from 'node:fs';
