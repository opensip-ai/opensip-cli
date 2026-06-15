/**
 * Python rule hints — declares language-specific signals for rules.
 *
 * Lands in PR 5 of plan docs/plans/10-graph-language-pluggability.md.
 * Each hint maps a generic rule input ("what counts as a test file?",
 * "what's a side-effect primitive?") onto Python conventions.
 *
 * Conservative on purpose: high-precision, low-recall. Rule authors may
 * extend the lists over time as false negatives surface in practice.
 */

import { isTestFile } from './walk.js';

import type { RuleHints } from '@opensip-cli/graph';

/**
 * Starter list of well-known Python side-effect primitives for
 * `no-side-effect-path`. Names are textual prefixes a developer would
 * actually write (e.g. `print(`, `os.system(`).
 */
const PYTHON_SIDE_EFFECT_PRIMITIVES: readonly string[] = [
  'print',
  'os.system',
  'os.remove',
  'os.unlink',
  'os.rmdir',
  'os.write',
  'os.makedirs',
  'os.rename',
  'subprocess.run',
  'subprocess.Popen',
  'subprocess.call',
  'subprocess.check_call',
  'subprocess.check_output',
  'open',
  'sys.exit',
  'sys.stdout.write',
  'sys.stderr.write',
  'random.random',
  'random.randint',
  'random.choice',
  'time.sleep',
  'requests.get',
  'requests.post',
  'requests.put',
  'requests.delete',
  'shutil.rmtree',
  'shutil.copy',
  'shutil.move',
];

/**
 * Throw-statement detection for `always-throws-branch`. Python's
 * raise syntax: `raise SomeError(...)` or bare `raise`. We accept
 * both forms by allowing optional whitespace and an optional
 * identifier.
 */
const PYTHON_THROW_REGEX = /\braise\b(?:\s+[A-Za-z_][\w.]*)?/;

/**
 * Generated-file globs Python projects commonly use. The TypeScript
 * adapter has its own list (`dist/`, `build/`, `.generated.`); we add
 * Python-specific ones (`*_pb2.py` from protoc).
 */
const PYTHON_GENERATED_FILE_PATTERNS: readonly string[] = [
  '**/*_pb2.py',
  '**/*_pb2_grpc.py',
  '**/migrations/**',
];

export const pythonRuleHints: RuleHints = {
  isTestFile,
  generatedFilePatterns: PYTHON_GENERATED_FILE_PATTERNS,
  sideEffectPrimitives: PYTHON_SIDE_EFFECT_PRIMITIVES,
  throwSyntaxRegex: PYTHON_THROW_REGEX,
};
