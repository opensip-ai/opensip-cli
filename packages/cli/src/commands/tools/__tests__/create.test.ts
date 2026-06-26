import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertManifestMatchesTool,
  loadToolManifest,
  PROJECT_LOCAL_MANIFEST_FILE,
} from '@opensip-cli/core';
import { describe, expect, it, afterEach } from 'vitest';

import { writeTemplateFiles } from '../create-template-writer.js';
import { TOOLS_CREATE_TEMPLATE_RENDERERS } from '../create-templates.js';
import { toolsCreate } from '../create.js';

let tmp: string;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('toolsCreate', () => {
  it('scaffolds minimal-js manifest + runtime under opensip-cli/tools/<id>/', () => {
    tmp = mkdtempSync(join(tmpdir(), 'ost-tools-create-'));
    const result = toolsCreate({ toolId: 'hello-tools', projectRoot: tmp });
    expect(result.success).toBe(true);
    expect(result.template).toBe('minimal-js');
    expect(result.files).toHaveLength(2);
    expect(result.nextSteps?.length).toBeGreaterThan(0);
    const toolDir = join(tmp, 'opensip-cli', 'tools', 'hello-tools');
    expect(existsSync(join(toolDir, PROJECT_LOCAL_MANIFEST_FILE))).toBe(true);
    expect(existsSync(join(toolDir, 'index.mjs'))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(toolDir, PROJECT_LOCAL_MANIFEST_FILE), 'utf8'),
    ) as {
      id: string;
      identity: { name: string };
      stableId: string;
      apiVersion: number;
      commands: { name: string }[];
    };
    expect(manifest.id).toBe('hello-tools');
    expect(manifest.identity.name).toBe('hello-tools');
    expect(manifest.stableId).toMatch(UUID_RE);
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.commands[0]?.name).toBe('hello-tools');
    const runtime = readFileSync(join(toolDir, 'index.mjs'), 'utf8');
    expect(runtime).not.toContain('@opensip-cli/');
    expect(runtime).toContain('export const tool');
    expect(runtime).toContain(`id: '${manifest.stableId}'`);
  });

  it('scaffolds ts-local package files', () => {
    tmp = mkdtempSync(join(tmpdir(), 'ost-tools-create-'));
    const result = toolsCreate({
      toolId: 'typed-tool',
      projectRoot: tmp,
      template: 'ts-local',
    });
    expect(result.success).toBe(true);
    expect(result.template).toBe('ts-local');
    expect(result.files.length).toBeGreaterThanOrEqual(6);
    const toolDir = join(tmp, 'opensip-cli', 'tools', 'typed-tool');
    for (const rel of [
      PROJECT_LOCAL_MANIFEST_FILE,
      'package.json',
      'tsconfig.json',
      'src/index.ts',
      'src/index.test.ts',
      'README.md',
    ]) {
      expect(existsSync(join(toolDir, rel))).toBe(true);
    }
    const manifest = JSON.parse(
      readFileSync(join(toolDir, PROJECT_LOCAL_MANIFEST_FILE), 'utf8'),
    ) as { main: string; stableId: string; identity: { name: string } };
    expect(manifest.main).toBe('./dist/index.js');
    expect(manifest.identity.name).toBe('typed-tool');
    expect(manifest.stableId).toMatch(UUID_RE);
    const pkg = JSON.parse(readFileSync(join(toolDir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(pkg.scripts.build).toBe('tsc');
    expect(pkg.dependencies['@opensip-cli/core']).toBeDefined();
    const source = readFileSync(join(toolDir, 'src/index.ts'), 'utf8');
    expect(source).toContain('createTool');
    expect(result.nextSteps?.some((step) => step.includes('pnpm install'))).toBe(true);
  });

  it('rejects invalid ids and unknown templates', () => {
    tmp = mkdtempSync(join(tmpdir(), 'ost-tools-create-'));
    const badId = toolsCreate({ toolId: 'Hello_Tools', projectRoot: tmp });
    expect(badId.success).toBe(false);
    const badTemplate = toolsCreate({
      toolId: 'demo-tool',
      projectRoot: tmp,
      template: 'npm-publish' as 'minimal-js',
    });
    expect(badTemplate.success).toBe(false);
    expect(badTemplate.error).toContain('unknown template');
  });

  it('refuses overwrite without --force', () => {
    tmp = mkdtempSync(join(tmpdir(), 'ost-tools-create-'));
    toolsCreate({ toolId: 'demo-tool', projectRoot: tmp });
    const again = toolsCreate({ toolId: 'demo-tool', projectRoot: tmp });
    expect(again.success).toBe(false);
    expect(again.error).toContain('already exists');
  });

  it('validates generated minimal-js manifest through loadToolManifest', () => {
    tmp = mkdtempSync(join(tmpdir(), 'ost-tools-create-'));
    toolsCreate({ toolId: 'manifest-tool', projectRoot: tmp });
    const toolDir = join(tmp, 'opensip-cli', 'tools', 'manifest-tool');
    const manifest = loadToolManifest('project-local', toolDir);
    expect(manifest).toBeDefined();
    expect(manifest?.identity.name).toBe('manifest-tool');
    expect(manifest?.stableId).toMatch(UUID_RE);
  });

  it('keeps manifest/runtime identity coherent for minimal-js', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ost-tools-create-'));
    toolsCreate({ toolId: 'coherent-tool', projectRoot: tmp });
    const toolDir = join(tmp, 'opensip-cli', 'tools', 'coherent-tool');
    const manifest = loadToolManifest('project-local', toolDir);
    expect(manifest).toBeDefined();
    const mod = (await import(`file://${join(toolDir, 'index.mjs')}`)) as {
      tool: Parameters<typeof assertManifestMatchesTool>[1];
    };
    assertManifestMatchesTool(manifest!, mod.tool);
  });
});

describe('writeTemplateFiles', () => {
  it('rejects unsafe relative paths and supports nested writes with --force', () => {
    tmp = mkdtempSync(join(tmpdir(), 'ost-tools-write-'));
    const toolDir = join(tmp, 'tool-dir');
    const rendered = TOOLS_CREATE_TEMPLATE_RENDERERS['minimal-js']({
      toolId: 'demo',
      stableId: '00000000-0000-4000-8000-000000000099',
      commandName: 'demo',
    });

    const unsafe = writeTemplateFiles({
      toolDir,
      files: [{ relativePath: '../escape.txt', content: 'nope' }],
    });
    expect(unsafe.success).toBe(false);

    const first = writeTemplateFiles({ toolDir, files: rendered.files });
    expect(first.success).toBe(true);

    const blocked = writeTemplateFiles({ toolDir, files: rendered.files });
    expect(blocked.success).toBe(false);

    const forced = writeTemplateFiles({ toolDir, files: rendered.files, force: true });
    expect(forced.success).toBe(true);
    expect(existsSync(join(toolDir, 'src', 'index.ts'))).toBe(false);
    expect(existsSync(join(toolDir, 'index.mjs'))).toBe(true);
  });
});
