import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROJECT_LOCAL_MANIFEST_FILE } from '@opensip-cli/core';
import { describe, expect, it, afterEach } from 'vitest';

import { toolsCreate } from '../create.js';

let tmp: string;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('toolsCreate', () => {
  it('scaffolds manifest + runtime under opensip-cli/tools/<id>/', () => {
    tmp = mkdtempSync(join(tmpdir(), 'ost-tools-create-'));
    const result = toolsCreate({ toolId: 'hello-tools', projectRoot: tmp });
    expect(result.success).toBe(true);
    expect(result.files).toHaveLength(2);
    const toolDir = join(tmp, 'opensip-cli', 'tools', 'hello-tools');
    expect(existsSync(join(toolDir, PROJECT_LOCAL_MANIFEST_FILE))).toBe(true);
    expect(existsSync(join(toolDir, 'index.mjs'))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(toolDir, PROJECT_LOCAL_MANIFEST_FILE), 'utf8'),
    ) as { id: string; commands: { name: string }[] };
    expect(manifest.id).toBe('hello-tools');
    expect(manifest.commands[0]?.name).toBe('hello-tools');
    const runtime = readFileSync(join(toolDir, 'index.mjs'), 'utf8');
    expect(runtime).not.toContain('@opensip-cli/');
    expect(runtime).toContain('export const tool');
  });

  it('rejects invalid ids', () => {
    tmp = mkdtempSync(join(tmpdir(), 'ost-tools-create-'));
    const result = toolsCreate({ toolId: 'Hello_Tools', projectRoot: tmp });
    expect(result.success).toBe(false);
  });

  it('refuses overwrite without --force', () => {
    tmp = mkdtempSync(join(tmpdir(), 'ost-tools-create-'));
    toolsCreate({ toolId: 'demo-tool', projectRoot: tmp });
    const again = toolsCreate({ toolId: 'demo-tool', projectRoot: tmp });
    expect(again.success).toBe(false);
    expect(again.error).toContain('already exists');
  });
});
