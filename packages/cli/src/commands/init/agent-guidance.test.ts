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

describe('ensureOpenSipAgentGuidance', () => {
  it('creates AGENTS.md with MCP-first guidance when absent', () => {
    const result = ensureOpenSipAgentGuidance(testDir, { toolScaffolds: [FIT_SCAFFOLD] });
    const agents = readFileSync(join(testDir, 'AGENTS.md'), 'utf8');
    expect(result.changed).toBe(true);
    expect(result.targets.find((target) => target.path.endsWith('AGENTS.md'))?.action).toBe(
      'created',
    );
    expect(agents).toContain('OpenSIP MCP First');
    expect(agents).toContain('list_runs');
    expect(agents).toContain('agent-fast');
  });

  it('updates existing AGENTS.md and preserves custom content', () => {
    writeFileSync(join(testDir, 'AGENTS.md'), '# Custom\n\nKeep me.\n', 'utf8');
    const result = ensureOpenSipAgentGuidance(testDir, { toolScaffolds: [FIT_SCAFFOLD] });
    const agents = readFileSync(join(testDir, 'AGENTS.md'), 'utf8');
    expect(result.targets.find((target) => target.path.endsWith('AGENTS.md'))?.action).toBe(
      'updated',
    );
    expect(agents).toContain('# Custom');
    expect(agents).toContain('Keep me.');
    expect(countBlocks(agents)).toBe(1);
  });

  it('updates existing CLAUDE.md but skips it when absent', () => {
    let result = ensureOpenSipAgentGuidance(testDir, { toolScaffolds: [FIT_SCAFFOLD] });
    expect(result.targets.find((target) => target.path.endsWith('CLAUDE.md'))?.action).toBe(
      'skipped',
    );

    writeFileSync(join(testDir, 'CLAUDE.md'), '# Claude\n\nCustom.\n', 'utf8');
    result = ensureOpenSipAgentGuidance(testDir, { toolScaffolds: [FIT_SCAFFOLD] });
    const claude = readFileSync(join(testDir, 'CLAUDE.md'), 'utf8');
    expect(result.targets.find((target) => target.path.endsWith('CLAUDE.md'))?.action).toBe(
      'updated',
    );
    expect(claude).toContain('Custom.');
    expect(claude).toContain('datastore.sqlite');
  });

  it('creates Cursor rule only when the parent directory already exists', () => {
    let result = ensureOpenSipAgentGuidance(testDir, { toolScaffolds: [FIT_SCAFFOLD] });
    const rulePath = join(testDir, '.cursor', 'rules', 'opensip.mdc');
    expect(result.targets.find((target) => target.path === rulePath)?.reason).toBe(
      'parent-missing',
    );
    expect(existsSync(rulePath)).toBe(false);

    mkdirSync(join(testDir, '.cursor', 'rules'), { recursive: true });
    result = ensureOpenSipAgentGuidance(testDir, { toolScaffolds: [FIT_SCAFFOLD] });
    expect(result.targets.find((target) => target.path === rulePath)?.action).toBe('created');
    expect(readFileSync(rulePath, 'utf8')).toContain('OpenSIP MCP First');
  });

  it('skips oversized existing instruction files without returning content', () => {
    const large = `${'x'.repeat(1024 * 1024 + 1)}\n`;
    writeFileSync(join(testDir, 'CLAUDE.md'), large, 'utf8');
    const result = ensureOpenSipAgentGuidance(testDir, { toolScaffolds: [FIT_SCAFFOLD] });
    const target = result.targets.find((item) => item.path.endsWith('CLAUDE.md'));
    expect(target?.action).toBe('skipped');
    expect(target?.reason).toBe('too-large');
    expect(JSON.stringify(target)).not.toContain(large.slice(0, 20));
  });
});
