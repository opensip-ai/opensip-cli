/**
 * Java rule hints — language-specific signals for rules.
 *
 * `isTestFile` honors both path-based (Maven/Gradle `src/test/java/`,
 * generic `/test/`) and filename-based (`*Test.java`, `*Tests.java`,
 * `*IT.java`) conventions. Either signal is sufficient.
 *
 * Throw-syntax: Java's structural error-propagation is `throw new X()`.
 * The regex matches the leading `throw` keyword.
 */

import { isTestFile } from './walk.js';

import type { RuleHints } from '@opensip-cli/graph';

const JAVA_SIDE_EFFECT_PRIMITIVES: readonly string[] = [
  'System.out.print',
  'System.out.println',
  'System.out.printf',
  'System.err.print',
  'System.err.println',
  'System.err.printf',
  'System.exit',
  'System.setProperty',
  'System.clearProperty',
  'Runtime.exit',
  'Runtime.halt',
  'Thread.sleep',
  'Math.random',
  'Files.write',
  'Files.delete',
  'Files.deleteIfExists',
  'Files.createFile',
  'Files.createDirectory',
  'Files.createDirectories',
];

// Java's structural throw analogue: `throw …` (no `panic!` macro).
// `throw new ExceptionType(...)` is by far the dominant form.
const JAVA_THROW_REGEX = /\bthrow\b/;

const JAVA_GENERATED_FILE_PATTERNS: readonly string[] = [
  '**/target/**',
  '**/build/**',
  '**/out/**',
  '**/generated/**',
  '**/generated-sources/**',
  '**/*$Pb.java',
];

export const javaRuleHints: RuleHints = {
  isTestFile,
  generatedFilePatterns: JAVA_GENERATED_FILE_PATTERNS,
  sideEffectPrimitives: JAVA_SIDE_EFFECT_PRIMITIVES,
  throwSyntaxRegex: JAVA_THROW_REGEX,
};
