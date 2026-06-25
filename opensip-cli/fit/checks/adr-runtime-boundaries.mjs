/**
 * @fileoverview ADR dogfood checks for runtime boundaries in opensip-cli.
 *
 * These checks are repo-local by design: they encode the first-party package
 * layout, known migration bridges, and output/runtime boundaries that only make
 * sense inside this monorepo.
 */
import path from 'node:path';

import { defineCheck } from '@opensip-cli/fitness';

const ROOT = process.cwd();

function relPath(filePath) {
  const raw = path.isAbsolute(filePath) ? path.relative(ROOT, filePath) : filePath;
  return raw.replaceAll('\\', '/');
}

function isTestOrFixture(filePath) {
  const rel = relPath(filePath);
  return (
    /\/__tests__\//.test(rel) ||
    /\/__fixtures__\//.test(rel) ||
    /\/fixtures?\//.test(rel) ||
    /\.test\.tsx?$/.test(rel)
  );
}

function isCommentOnly(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

function lineOfNeedle(content, needle) {
  const index = content.indexOf(needle);
  return index < 0 ? 1 : lineOf(content, index);
}

function violation(filePath, line, type, message, suggestion) {
  return { filePath, line, type, message, severity: 'error', suggestion };
}

// ---------------------------------------------------------------------------
// ADR-0010: tree-sitter lifecycle belongs to the shared substrate.
// ---------------------------------------------------------------------------

const TREE_SITTER_SUBSTRATE = /^packages\/tree-sitter\/src\//;
const LANGUAGE_PARSE_FILE = /^packages\/languages\/lang-[^/]+\/src\/parse\.ts$/;

function analyzeTreeSitterOwnership(content, filePath) {
  const rel = relPath(filePath);
  if (isTestOrFixture(rel) || TREE_SITTER_SUBSTRATE.test(rel)) return [];

  const violations = [];
  const canCreateLanguageParser = LANGUAGE_PARSE_FILE.test(rel);
  const lines = content.split('\n');
  for (const [index, line] of lines.entries()) {
    if (isCommentOnly(line)) continue;
    const lineNo = index + 1;
    if (/^\s*import\b.*\bfrom\s*['"]web-tree-sitter['"]/.test(line)) {
      violations.push(
        violation(
          filePath,
          lineNo,
          'tree-sitter-direct-import',
          'Direct web-tree-sitter imports must stay inside packages/tree-sitter/src (ADR-0010).',
          'Import parser helpers or types from @opensip-cli/tree-sitter instead of binding directly to web-tree-sitter.',
        ),
      );
    }
    if (/\b(?:await\s+)?Parser\.init\s*\(|\bnew\s+Parser\s*\(|\bLanguage\.load\s*\(/.test(line)) {
      violations.push(
        violation(
          filePath,
          lineNo,
          'tree-sitter-lifecycle-outside-substrate',
          'Parser lifecycle calls must stay in the tree-sitter substrate (ADR-0010).',
          'Move Parser.init(), Language.load(), and Parser construction behind packages/tree-sitter/src lifecycle helpers.',
        ),
      );
    }
    if (!canCreateLanguageParser && /\bcreateParser\s*\(/.test(line)) {
      violations.push(
        violation(
          filePath,
          lineNo,
          'tree-sitter-parser-factory-outside-language-parse',
          'Only language parse.ts adapters should create parser instances from the shared substrate (ADR-0010).',
          'Keep graph adapters and callers behind the language adapter parse contract; parser creation belongs in packages/languages/lang-*/src/parse.ts.',
        ),
      );
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// ADR-0028: live runs fork the heavy work away from the render thread.
// ---------------------------------------------------------------------------

const LIVE_RUNNER_FILES = new Set([
  'packages/fitness/engine/src/cli/fit-runner.tsx',
  'packages/graph/engine/src/cli/graph-runner.tsx',
  'packages/simulation/engine/src/cli/sim-runner.tsx',
]);

const LIVE_WORKER_FILES = new Set([
  'packages/fitness/engine/src/cli/fit-worker.ts',
  'packages/graph/engine/src/cli/graph-worker.ts',
  'packages/simulation/engine/src/cli/sim-worker.ts',
]);

function analyzeLiveRunnerOffThread(content, filePath) {
  const rel = relPath(filePath);
  if (isTestOrFixture(rel)) return [];
  const violations = [];
  if (LIVE_RUNNER_FILES.has(rel)) {
    if (!content.includes('runOffThreadOrInProcess')) {
      violations.push(
        violation(
          filePath,
          1,
          'live-runner-not-off-thread',
          'Live runner must launch heavy analysis through runOffThreadOrInProcess (ADR-0028).',
          'Keep the Ink/render parent responsive by forking the heavy run through the shared progress transport.',
        ),
      );
    }
    if (content.includes('createInProcessTransport')) {
      violations.push(
        violation(
          filePath,
          lineOfNeedle(content, 'createInProcessTransport'),
          'live-runner-forces-in-process-transport',
          'Live runners must not force the in-process transport (ADR-0028).',
          'Use runOffThreadOrInProcess so subprocess execution remains the default and fallback stays centralized in core.',
        ),
      );
    }
  }
  const sendsWorkerIpc =
    /process\.send(?:\?\.)?\s*\(/.test(content) || /\bsendWorkerIpcMessage\s*\(/.test(content);
  if (LIVE_WORKER_FILES.has(rel) && !sendsWorkerIpc) {
    violations.push(
      violation(
        filePath,
        1,
        'live-worker-no-ipc-progress',
        'Live worker commands must stream progress/results over process.send IPC (ADR-0028).',
        'Keep the worker protocol serializable and parent-rendered; do not make the worker own interactive output.',
      ),
    );
  }
  return violations;
}

// ---------------------------------------------------------------------------
// ADR-0035: host-owned verdict migration ratchet.
// ---------------------------------------------------------------------------

const HOST_VERDICT_BRIDGE_FILES = new Set([
  'packages/contracts/src/command-results.ts',
  'packages/contracts/src/signal-envelope.ts',
  'packages/fitness/engine/src/types/findings.ts',
  'packages/fitness/engine/src/cli/fit/result-builders.ts',
  'packages/fitness/engine/src/cli/fit-modes.ts',
  'packages/fitness/engine/src/cli/fit-runner.tsx',
  'packages/graph/engine/src/cli/graph-modes.ts',
  'packages/simulation/engine/src/cli/sim.ts',
  'packages/simulation/engine/src/cli/sim-runner.tsx',
  'packages/simulation/engine/src/tool.ts',
]);

function analyzeHostOwnedVerdictRatchet(content, filePath) {
  const rel = relPath(filePath);
  if (isTestOrFixture(rel) || HOST_VERDICT_BRIDGE_FILES.has(rel)) return [];
  if (
    !/^packages\/(?:contracts|fitness\/engine|graph\/engine|simulation\/engine)\/src\//.test(rel)
  ) {
    return [];
  }
  const violations = [];
  const lines = content.split('\n');
  for (const [index, line] of lines.entries()) {
    if (isCommentOnly(line)) continue;
    if (/\bshouldFail\b|\bpassed\s*:\s*errors\s*===\s*0/.test(line)) {
      violations.push(
        violation(
          filePath,
          index + 1,
          'tool-owned-verdict-outside-bridge',
          'New shouldFail/passed verdict decisions are blocked outside the known ADR-0035 bridge files.',
          'Route pass/fail decisions through the host-owned verdict model, or add a temporary bridge allowlist entry with the migration justification.',
        ),
      );
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// ADR-0024: one structured outcome shape, no new direct JSON stdout writers.
// ---------------------------------------------------------------------------

const DIRECT_JSON_STDOUT_ALLOWLIST = new Set([
  'packages/cli/src/commands/render-outcome.ts',
  'packages/graph/engine/src/cli/shard-worker.ts',
  'packages/graph/engine/src/cli/lookup.ts',
]);

function analyzeOneOutcomeShape(content, filePath) {
  const rel = relPath(filePath);
  if (isTestOrFixture(rel) || DIRECT_JSON_STDOUT_ALLOWLIST.has(rel)) return [];
  if (!/^packages\/(?:cli|fitness\/engine|graph\/engine|simulation\/engine)\/src\//.test(rel)) {
    return [];
  }
  const violations = [];
  const lines = content.split('\n');
  for (const [index, line] of lines.entries()) {
    if (isCommentOnly(line)) continue;
    if (/process\.stdout\.write\s*\(\s*JSON\.stringify\s*\(/.test(line)) {
      violations.push(
        violation(
          filePath,
          index + 1,
          'direct-json-stdout-outside-outcome-renderer',
          'Direct JSON stdout writers bypass the single outcome renderer (ADR-0024).',
          'Return a CommandOutcome/SignalEnvelope or use cli.emitJson from the command context. Add an allowlist only for internal worker protocols.',
        ),
      );
    }
    if (/\bemitJson\s*\(\s*\{\s*error\b/.test(line)) {
      violations.push(
        violation(
          filePath,
          index + 1,
          'bare-json-error-shape',
          'Bare emitJson({ error }) bypasses the structured error/outcome shape (ADR-0024).',
          'Use cli.emitError or return a structured CommandOutcome so JSON and text modes share the same envelope.',
        ),
      );
    }
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: 'c6b332d1-a79b-4371-b914-bdd3db3313b2',
    slug: 'dogfood-no-tree-sitter-outside-substrate',
    description:
      'tree-sitter parser lifecycle must stay in the shared substrate and language parse adapters (ADR-0010)',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'dogfood'],
    fileTypes: ['ts', 'tsx'],
    contentFilter: 'raw',
    analyze: analyzeTreeSitterOwnership,
  }),
  defineCheck({
    id: 'a42c6cf6-1c2a-4413-8fd8-ee141c93b3be',
    slug: 'dogfood-live-runner-off-thread',
    description:
      'fit/graph/sim live runners must fork heavy work through the shared off-thread progress transport (ADR-0028)',
    scope: { languages: ['typescript'], concerns: ['backend', 'cli'] },
    tags: ['architecture', 'dogfood'],
    fileTypes: ['ts', 'tsx'],
    contentFilter: 'raw',
    analyze: analyzeLiveRunnerOffThread,
  }),
  defineCheck({
    id: '10469ba0-835b-485d-b9bc-74e5ad7b31a9',
    slug: 'dogfood-host-owned-verdict-ratchet',
    description:
      'no new tool-owned shouldFail/passed verdict decisions outside known ADR-0035 bridge files',
    scope: { languages: ['typescript'], concerns: ['backend', 'cli'] },
    tags: ['architecture', 'dogfood'],
    fileTypes: ['ts', 'tsx'],
    contentFilter: 'raw',
    analyze: analyzeHostOwnedVerdictRatchet,
  }),
  defineCheck({
    id: 'b26479c3-b73a-4995-a322-011f70982521',
    slug: 'dogfood-one-outcome-shape',
    description:
      'new structured output must flow through the outcome/json seams, not direct JSON stdout writers (ADR-0024)',
    scope: { languages: ['typescript'], concerns: ['backend', 'cli'] },
    tags: ['architecture', 'dogfood'],
    fileTypes: ['ts', 'tsx'],
    contentFilter: 'raw',
    analyze: analyzeOneOutcomeShape,
  }),
];
