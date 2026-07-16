import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_GUIDANCE_END,
  AGENT_GUIDANCE_START,
  buildManagedAgentGuidance,
  ensureOpenSipAgentGuidance,
  upsertManagedBlock,
} from './agent-guidance.js';

import type { ToolScaffold } from '../shared.js';

const FIT_SCAFFOLD: ToolScaffold = {
  layout: { domain: 'fit', userSubdirs: [] },
};

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-agent-guidance-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function countBlocks(content: string): number {
  return content.split(AGENT_GUIDANCE_START).length - 1;
}

describe('upsertManagedBlock', () => {
  const block = buildManagedAgentGuidance();

  it('inserts at the top of an empty document', () => {
    const result = upsertManagedBlock('', block);
    expect(result.changed).toBe(true);
    expect(result.content.startsWith(AGENT_GUIDANCE_START)).toBe(true);
    expect(countBlocks(result.content)).toBe(1);
  });

  it('inserts after frontmatter', () => {
    const result = upsertManagedBlock('---\ntitle: Test\n---\n\n# Title\n', block);
    expect(result.content).toMatch(
      /^---\ntitle: Test\n---\n\n<!-- opensip:agent-guidance start -->/,
    );
  });

  it('inserts after a top-level title', () => {
    const result = upsertManagedBlock('# Existing\n\nBody\n', block);
    expect(result.content).toMatch(/^# Existing\n\n<!-- opensip:agent-guidance start -->/);
  });

  it('replaces an existing block without duplicating it', () => {
    const old = [
      '# Existing',
      '',
      AGENT_GUIDANCE_START,
      'old',
      AGENT_GUIDANCE_END,
      '',
      'Body',
      '',
    ].join('\n');
    const once = upsertManagedBlock(old, block);
    const twice = upsertManagedBlock(once.content, block);
    expect(countBlocks(once.content)).toBe(1);
    expect(twice.changed).toBe(false);
    expect(twice.content).toBe(once.content);
    expect(twice.content).not.toContain('\nold\n');
  });

  it('repairs an orphan start marker without duplicating managed blocks', () => {
    const old = [
      '# Existing',
      '',
      AGENT_GUIDANCE_START,
      'stale generated text',
      '',
      'Body',
      '',
    ].join('\n');
    const once = upsertManagedBlock(old, block);
    const twice = upsertManagedBlock(once.content, block);
    expect(countBlocks(once.content)).toBe(1);
    expect(twice.changed).toBe(false);
    expect(twice.content).toBe(once.content);
    expect(twice.content).toContain('stale generated text');
    expect(twice.content).toContain('Body');
  });

  it('preserves CRLF when inserting', () => {
    const result = upsertManagedBlock('# Existing\r\n\r\nBody\r\n', block);
    expect(result.content).toContain(`${AGENT_GUIDANCE_START}\r\n## OpenSIP MCP First`);
  });
});

describe('buildManagedAgentGuidance', () => {
  it('documents the auto-swap, package, and live-wiring workflow', () => {
    const guidance = buildManagedAgentGuidance();
    expect(guidance).toContain('context.project.root');
    expect(guidance).toContain('context.catalog.identity');
    expect(guidance).toContain('opaque `g1:` catalog generation identity');
    expect(guidance).toContain('project key is a separate cursor binding only');
    expect(guidance).toContain('complete` versus `partial');
    expect(guidance).toContain('effective filters');
    expect(guidance).toContain('evidence kind/confidence');
    expect(guidance).toContain('four coverage facets');
    expect(guidance).toContain('inventory / evidence / grouping / projection');
    expect(guidance).toContain('returned cursor');
    expect(guidance).toContain('auto-load a newer catalog');
    expect(guidance).toContain('get_agent_catalog');
    expect(guidance).toContain('get_architecture');
    expect(guidance).toContain('search_declarations');
    expect(guidance).toContain('references_to');
    expect(guidance).toContain('package_dependencies');
    expect(guidance).toContain('why_depends');
    expect(guidance).toContain('package_cycles');
    expect(guidance).toContain('get_runtime_wiring');
    // The deferred agent-context guidance (get_context_status / get_file_context /
    // impact_files / select_tests / suite run agent-context / audit edit-loop) was
    // intentionally removed from the managed block; assert it stays out so it can't
    // silently return. The graph-audit + tool-precedence guidance remains authoritative.
    expect(guidance).not.toContain('get_context_status');
    expect(guidance).not.toContain('get_file_context');
    expect(guidance).not.toContain('impact_files');
    expect(guidance).not.toContain('select_tests');
    expect(guidance).not.toContain('suite run agent-context');
    expect(guidance).toContain('default to 20 nodes');
    expect(guidance).toContain('exclusive compact detail modes');
    expect(guidance).toContain('runtime edges, not call edges');
    expect(guidance).toContain('cannot repair a stale connector inventory');
    expect(guidance).toContain('never to fix a stale connector');
    expect(guidance).not.toMatch(/pinned in-memory generation|refresh_graph once so its pinned/i);
    // Negative: project key is not response context; declarations are not callable.
    expect(guidance).toContain('never treat it as response context');
    expect(guidance).toContain('declaration IDs are not callable symbolIds');
    // Forbid affirmative "use refresh_graph to repair connector" guidance.
    expect(guidance).not.toMatch(
      /use `refresh_graph` to (repair|fix|update) (a |the )?(stale )?connector/i,
    );
    expect(guidance).not.toMatch(/reconnect.*(via|with|using) `refresh_graph`/i);
  });

  it('matches the checked-in AGENTS.md / CLAUDE.md managed blocks', () => {
    const expected = buildManagedAgentGuidance();
    // Repo root is three levels above this test file (packages/cli/src/commands/init).
    const repoRoot = join(import.meta.dirname, '..', '..', '..', '..', '..');
    for (const name of ['AGENTS.md', 'CLAUDE.md'] as const) {
      const content = readFileSync(join(repoRoot, name), 'utf8');
      const start = content.indexOf(AGENT_GUIDANCE_START);
      const end = content.indexOf(AGENT_GUIDANCE_END);
      expect(start, name).toBeGreaterThanOrEqual(0);
      expect(end, name).toBeGreaterThan(start);
      const block = content.slice(start, end + AGENT_GUIDANCE_END.length);
      expect(block, name).toBe(expected);
    }
  });
});

describe('ensureOpenSipAgentGuidance', () => {
  it('creates AGENTS.md with MCP-first guidance when absent', () => {
    const result = ensureOpenSipAgentGuidance(testDir, {
      toolScaffolds: [FIT_SCAFFOLD],
    });
    const agents = readFileSync(join(testDir, 'AGENTS.md'), 'utf8');
    expect(result.changed).toBe(true);
    expect(result.targets.find((target) => target.path.endsWith('AGENTS.md'))?.action).toBe(
      'created',
    );
    expect(agents).toContain('OpenSIP MCP First');
    expect(agents).toContain('list_runs');
    expect(agents).toContain('opensip audit --json');
    expect(agents).toContain('opensip suite run agent-context');
    expect(agents).toContain('agent-fast');
    expect(agents.indexOf('opensip audit --json')).toBeLessThan(
      agents.indexOf('opensip fit --recipe agent-fast'),
    );
  });

  it('updates existing AGENTS.md and preserves custom content', () => {
    writeFileSync(join(testDir, 'AGENTS.md'), '# Custom\n\nKeep me.\n', 'utf8');
    const result = ensureOpenSipAgentGuidance(testDir, {
      toolScaffolds: [FIT_SCAFFOLD],
    });
    const agents = readFileSync(join(testDir, 'AGENTS.md'), 'utf8');
    expect(result.targets.find((target) => target.path.endsWith('AGENTS.md'))?.action).toBe(
      'updated',
    );
    expect(agents).toContain('# Custom');
    expect(agents).toContain('Keep me.');
    expect(countBlocks(agents)).toBe(1);
  });

  it('replaces stale managed text on repeat init while preserving custom content', () => {
    writeFileSync(
      join(testDir, 'AGENTS.md'),
      [
        '# Custom',
        '',
        AGENT_GUIDANCE_START,
        'Call refresh_graph once so its pinned in-memory generation changes.',
        AGENT_GUIDANCE_END,
        '',
        'Keep this custom tail.',
      ].join('\n'),
      'utf8',
    );
    ensureOpenSipAgentGuidance(testDir, { toolScaffolds: [FIT_SCAFFOLD] });
    ensureOpenSipAgentGuidance(testDir, { toolScaffolds: [FIT_SCAFFOLD] });
    const agents = readFileSync(join(testDir, 'AGENTS.md'), 'utf8');
    expect(countBlocks(agents)).toBe(1);
    expect(agents).toContain('Keep this custom tail.');
    expect(agents).toContain('auto-load a newer catalog');
    expect(agents).not.toContain('pinned in-memory generation');
  });

  it('updates existing CLAUDE.md but skips it when absent', () => {
    let result = ensureOpenSipAgentGuidance(testDir, {
      toolScaffolds: [FIT_SCAFFOLD],
    });
    expect(result.targets.find((target) => target.path.endsWith('CLAUDE.md'))?.action).toBe(
      'skipped',
    );

    writeFileSync(join(testDir, 'CLAUDE.md'), '# Claude\n\nCustom.\n', 'utf8');
    result = ensureOpenSipAgentGuidance(testDir, {
      toolScaffolds: [FIT_SCAFFOLD],
    });
    const claude = readFileSync(join(testDir, 'CLAUDE.md'), 'utf8');
    expect(result.targets.find((target) => target.path.endsWith('CLAUDE.md'))?.action).toBe(
      'updated',
    );
    expect(claude).toContain('Custom.');
    expect(claude).toContain('datastore.sqlite');
  });

  it('keeps existing AGENTS.md and CLAUDE.md managed blocks byte-identical and idempotent', () => {
    writeFileSync(join(testDir, 'AGENTS.md'), '# Agents\n\nCustom agents.\n', 'utf8');
    writeFileSync(
      join(testDir, 'CLAUDE.md'),
      [
        '# Claude',
        '',
        AGENT_GUIDANCE_START,
        'stale',
        AGENT_GUIDANCE_END,
        '',
        'Custom claude.',
      ].join('\n'),
      'utf8',
    );

    const first = ensureOpenSipAgentGuidance(testDir, {
      toolScaffolds: [FIT_SCAFFOLD],
    });
    const agents = readFileSync(join(testDir, 'AGENTS.md'), 'utf8');
    const claude = readFileSync(join(testDir, 'CLAUDE.md'), 'utf8');
    const expected = buildManagedAgentGuidance();
    expect(agents).toContain(expected);
    expect(claude).toContain(expected);
    expect(first.targets.find((target) => target.path.endsWith('AGENTS.md'))?.action).toBe(
      'updated',
    );
    expect(first.targets.find((target) => target.path.endsWith('CLAUDE.md'))?.action).toBe(
      'updated',
    );

    const second = ensureOpenSipAgentGuidance(testDir, {
      toolScaffolds: [FIT_SCAFFOLD],
    });
    expect(second.changed).toBe(false);
    expect(readFileSync(join(testDir, 'AGENTS.md'), 'utf8')).toBe(agents);
    expect(readFileSync(join(testDir, 'CLAUDE.md'), 'utf8')).toBe(claude);
  });

  it('creates Cursor rule only when the parent directory already exists', () => {
    let result = ensureOpenSipAgentGuidance(testDir, {
      toolScaffolds: [FIT_SCAFFOLD],
    });
    const rulePath = join(testDir, '.cursor', 'rules', 'opensip.mdc');
    expect(result.targets.find((target) => target.path === rulePath)?.reason).toBe(
      'parent-missing',
    );
    expect(existsSync(rulePath)).toBe(false);

    mkdirSync(join(testDir, '.cursor', 'rules'), { recursive: true });
    result = ensureOpenSipAgentGuidance(testDir, {
      toolScaffolds: [FIT_SCAFFOLD],
    });
    expect(result.targets.find((target) => target.path === rulePath)?.action).toBe('created');
    expect(readFileSync(rulePath, 'utf8')).toContain('OpenSIP MCP First');
  });

  it('skips oversized existing instruction files without returning content', () => {
    const large = `${'x'.repeat(1024 * 1024 + 1)}\n`;
    writeFileSync(join(testDir, 'CLAUDE.md'), large, 'utf8');
    const result = ensureOpenSipAgentGuidance(testDir, {
      toolScaffolds: [FIT_SCAFFOLD],
    });
    const target = result.targets.find((item) => item.path.endsWith('CLAUDE.md'));
    expect(target?.action).toBe('skipped');
    expect(target?.reason).toBe('too-large');
    expect(JSON.stringify(target)).not.toContain(large.slice(0, 20));
  });
});
