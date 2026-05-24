/**
 * Rust rule hints — language-specific signals for rules.
 *
 * Lands in PR 6 of plan docs/plans/10-graph-language-pluggability.md.
 *
 * `isTestFile` is file-path-based here for simplicity: `tests/`
 * directory or `*_test.rs`. Note that Rust convention also supports
 * `#[test]`-annotated functions in any file (commonly inside
 * `#[cfg(test)] mod tests { … }`); the walk pass tags those
 * occurrences' `inTestFile` flag as true based on the attribute, so
 * `test-only-reachable` still works for them. The hint here is the
 * file-level fallback for rules that consult the predicate directly.
 */

import { isTestFile } from './walk.js';

import type { RuleHints } from '@opensip-tools/graph';

const RUST_SIDE_EFFECT_PRIMITIVES: readonly string[] = [
  'println!',
  'eprintln!',
  'print!',
  'eprint!',
  'std::fs::read',
  'std::fs::write',
  'std::fs::remove_file',
  'std::fs::remove_dir',
  'std::fs::create_dir',
  'std::io::stdin',
  'std::io::stdout',
  'std::io::stderr',
  'std::process::exit',
  'std::process::abort',
  'std::env::set_var',
  'std::env::remove_var',
  'std::thread::sleep',
  'rand::random',
];

// `raise` doesn't exist in Rust; the closest analogues are `panic!`,
// `return Err(...)`, and `?` — but only `panic!` is structural. Use
// the `panic!` macro shape.
const RUST_THROW_REGEX = /\bpanic!\s*\(/;

const RUST_GENERATED_FILE_PATTERNS: readonly string[] = [
  '**/target/**',
  '**/build/**',
  '**/*.generated.rs',
];

export const rustRuleHints: RuleHints = {
  isTestFile,
  generatedFilePatterns: RUST_GENERATED_FILE_PATTERNS,
  sideEffectPrimitives: RUST_SIDE_EFFECT_PRIMITIVES,
  throwSyntaxRegex: RUST_THROW_REGEX,
};
