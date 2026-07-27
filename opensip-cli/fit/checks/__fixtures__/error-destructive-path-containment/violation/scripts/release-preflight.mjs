// VIOLATION fixture for `error-destructive-path-containment`.
//
// Reduced from a REAL confirmed site in this repo:
//   scripts/release-preflight.mjs  (parseArgs L26-52 -> rmSync L122)
//
// `--tarball-dir` is accepted from argv with the ONLY validation being a reject
// of the two literal strings 'undefined' and 'null' — no `isAbsolute`, no
// ownership marker, no containment against a root we own. `main()` then
// `rm -rf`s it. The blast radius of this call is whatever the operator typed
// (or whatever a wrapper script interpolated into the flag).
//
// Expected: ONE finding, on the rmSync line.

import { mkdirSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_TARBALL_PREFIX = join(tmpdir(), 'opensip-cli-release-tarballs-');

function parseArgs(argv) {
  const out = { tarballDir: mkdtempSync(DEFAULT_TARBALL_PREFIX) };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tarball-dir') {
      const value = argv[++i];
      if (!value) throw new Error('--tarball-dir requires a value');
      // Fail closed on the classic JS stringification of a missing path.
      if (value === 'undefined' || value === 'null') {
        throw new Error(`--tarball-dir must be a real path (got ${JSON.stringify(value)})`);
      }
      out.tarballDir = value;
    }
  }
  return out;
}

export function main() {
  const args = parseArgs(process.argv.slice(2));

  // The deleted path is `args.tarballDir` — a string this file never derived.
  // Nothing between parseArgs and here proves it is inside a root we own.
  rmSync(args.tarballDir, { recursive: true, force: true });
  mkdirSync(args.tarballDir, { recursive: true });
}
