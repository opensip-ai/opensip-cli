/**
 * Go rule hints — language-specific signals for rules.
 *
 * `isTestFile` is file-path-based: Go convention enforces `*_test.go`
 * via the `go test` toolchain, so this predicate is exact for the test
 * concept. No directory convention exists in Go (tests live next to
 * source).
 *
 * Throw-syntax analogue: Go's structural error-propagation is
 * `panic(...)`. The `?` / `try!()` analogue doesn't exist; `return err`
 * is the conventional error path but is too varied syntactically for a
 * regex.
 */

import { isTestFile } from './walk.js';

import type { RuleHints } from '@opensip-tools/graph';

const GO_SIDE_EFFECT_PRIMITIVES: readonly string[] = [
  'fmt.Print',
  'fmt.Println',
  'fmt.Printf',
  'fmt.Fprint',
  'fmt.Fprintln',
  'fmt.Fprintf',
  'log.Print',
  'log.Println',
  'log.Printf',
  'log.Fatal',
  'log.Fatalln',
  'log.Fatalf',
  'log.Panic',
  'log.Panicln',
  'log.Panicf',
  'os.Exit',
  'os.Setenv',
  'os.Unsetenv',
  'os.Remove',
  'os.RemoveAll',
  'os.Create',
  'os.WriteFile',
  'os.ReadFile',
  'os.Mkdir',
  'os.MkdirAll',
  'time.Sleep',
  'rand.Int',
  'rand.Intn',
  'rand.Float64',
];

// Go's structural throw analogue is `panic(...)`. `return err` is also
// an error path but is too varied to capture via regex.
const GO_THROW_REGEX = /\bpanic\s*\(/;

const GO_GENERATED_FILE_PATTERNS: readonly string[] = [
  '**/vendor/**',
  '**/*.pb.go',
  '**/*_generated.go',
  '**/*.gen.go',
  '**/zz_generated_*.go',
];

export const goRuleHints: RuleHints = {
  isTestFile,
  generatedFilePatterns: GO_GENERATED_FILE_PATTERNS,
  sideEffectPrimitives: GO_SIDE_EFFECT_PRIMITIVES,
  throwSyntaxRegex: GO_THROW_REGEX,
};
