import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertManifestMatchesTool,
  loadToolManifest,
  PROJECT_LOCAL_MANIFEST_FILE,
} from '@opensip-cli/core';
import ts from 'typescript';
import { describe, expect, it, afterEach } from 'vitest';

import { writeTemplateFiles } from '../create-template-writer.js';
import { TOOLS_CREATE_TEMPLATE_RENDERERS } from '../create-templates.js';
import { toolsCreate } from '../create.js';
import { runToolValidation } from '../validate.js';

interface TemplateTypecheckResult {
  readonly ok: boolean;
  readonly diagnostics: readonly string[];
}

/**
 * @throws Error when no workspace root can be found above `start`.
 */
function findRepoRoot(start: string): string {
  let dir = start;
  while (dir !== dirname(dir)) {
    const workspacePath = join(dir, 'pnpm-workspace.yaml');
    if (existsSync(workspacePath)) return dir;
    dir = dirname(dir);
  }
  throw new Error(`Could not find repository root from ${start}`);
}

const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const requireFromHere = createRequire(import.meta.url);
const vitestTypesPath = join(
  dirname(requireFromHere.resolve('vitest/package.json')),
  'dist/index.d.ts',
);

/**
 * @throws Error when template typechecking prerequisites have not been built or installed.
 */
function assertWorkspacePrerequisites(): void {
  const coreDist = join(repoRoot, 'packages/core/dist/index.d.ts');
  if (!existsSync(coreDist)) {
    throw new Error(
      `Template typecheck requires built @opensip-cli/core at ${coreDist}. Run pnpm build first.`,
    );
  }
  const contractsDist = join(repoRoot, 'packages/contracts/dist/index.d.ts');
  if (!existsSync(contractsDist)) {
    throw new Error(
      `Template typecheck requires built @opensip-cli/contracts at ${contractsDist}. Run pnpm build first.`,
    );
  }
  try {
    requireFromHere.resolve('vitest');
  } catch {
    throw new Error('Template typecheck requires workspace dev dependency vitest to be installed.');
  }
}

function writeRenderedTemplateFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

function compilerConfig(root: string): Record<string, unknown> {
  return {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
      ignoreDeprecations: '6.0',
      baseUrl: root,
      types: ['node'],
      paths: {
        '@opensip-cli/core': [join(repoRoot, 'packages/core/dist/index.d.ts')],
        '@opensip-cli/core/*': [join(repoRoot, 'packages/core/dist/*')],
        '@opensip-cli/contracts': [join(repoRoot, 'packages/contracts/dist/index.d.ts')],
        '@opensip-cli/contracts/*': [join(repoRoot, 'packages/contracts/dist/*')],
        vitest: [vitestTypesPath],
      },
    },
    include: ['src/**/*.ts', 'src/**/*.tsx'],
  };
}

/**
 * @throws Error when workspace prerequisites needed for template typechecking are unavailable.
 */
function typecheckRenderedTemplate(files: Record<string, string>): TemplateTypecheckResult {
  assertWorkspacePrerequisites();
  const root = mkdtempSync(join(tmpdir(), 'opensip-template-typecheck-'));
  try {
    writeRenderedTemplateFiles(root, files);
    const config = compilerConfig(root);
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: parsed.options,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    const host: ts.FormatDiagnosticsHost = {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    };
    return {
      ok: diagnostics.length === 0,
      diagnostics:
        diagnostics.length === 0
          ? []
          : [ts.formatDiagnosticsWithColorAndContext(diagnostics, host)],
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

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
    expect(runtime).toContain('cli.logger.info');
    expect(runtime).toContain('cli.reportFailure');
    const config = readFileSync(join(tmp, 'opensip-cli.config.yml'), 'utf8');
    expect(config).toContain('tools:');
    expect(config).toContain('trusted:');
    expect(config).toContain('"hello-tools"');
    expect(result.nextSteps?.join('\n')).not.toContain('OPENSIP_CLI_ALLOW_PROJECT_TOOLS');
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
    expect(source).toContain('createToolLogger');
    expect(source).toContain('reportFailure');
    expect(result.nextSteps?.some((step) => step.includes('pnpm install'))).toBe(true);
    expect(readFileSync(join(tmp, 'opensip-cli.config.yml'), 'utf8')).toContain('typed-tool');
    expect(result.nextSteps?.join('\n')).not.toContain('OPENSIP_CLI_ALLOW_PROJECT_TOOLS');
  });

  it('refuses to overwrite malformed tools.trusted config', () => {
    tmp = mkdtempSync(join(tmpdir(), 'ost-tools-create-'));
    writeFileSync(join(tmp, 'opensip-cli.config.yml'), 'tools:\n  trusted: audit-sec\n');

    const result = toolsCreate({ toolId: 'audit-sec', projectRoot: tmp });

    expect(result.success).toBe(false);
    expect(result.error).toContain('tools.trusted must be a sequence');
  });

  it('a scaffolded tool passes `tools validate` static sections (create→validate loop)', async () => {
    // Regression: `tools validate` admitted candidates as source 'installed'
    // (reading package.json#opensipTools), but `tools create` writes only the
    // project-local sidecar — so a freshly scaffolded tool failed admission with
    // "manifest missing or malformed". Both templates must validate.
    for (const template of ['minimal-js', 'ts-local'] as const) {
      const root = mkdtempSync(join(tmpdir(), 'ost-tools-validate-'));
      try {
        const id = template === 'minimal-js' ? 'hello-tools' : 'typed-tool';
        expect(toolsCreate({ toolId: id, projectRoot: root, template }).success).toBe(true);
        const toolDir = join(root, 'opensip-cli', 'tools', id);
        const { result, cleanup } = await runToolValidation({
          spec: toolDir,
          cwd: root,
        });
        cleanup();
        const sectionStatus = (name: string): string | undefined =>
          result.sections.find((s) => s.name === name)?.status;
        // The sidecar is read as 'project-local' — NOT "manifest missing or malformed".
        expect(sectionStatus('manifest')).toBe('passed');
        expect(sectionStatus('compatibility')).toBe('passed');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
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

  it('typechecks the rendered ts-local template under strict settings', () => {
    const rendered = TOOLS_CREATE_TEMPLATE_RENDERERS['ts-local']({
      toolId: 'typed-tool',
      stableId: '00000000-0000-4000-8000-000000000099',
      commandName: 'typed-tool',
    });
    const result = typecheckRenderedTemplate(
      Object.fromEntries(rendered.files.map((file) => [file.relativePath, file.content])),
    );

    expect(result.diagnostics.join('\n')).toBe('');
    expect(result.ok).toBe(true);
  });

  it('template typecheck harness rejects the pre-fix unknown opts access', () => {
    const result = typecheckRenderedTemplate({
      'src/index.ts': `import { createTool } from '@opensip-cli/core';

export const tool = createTool({
  identity: { name: 'bad-template' },
  metadata: { id: 'bad-template', version: '0.1.0', description: 'bad' },
  primaryCommand: {
    description: 'bad',
    output: 'command-result',
    handler: async (opts, cli) => {
      try {
        return { type: 'text-lines', lines: ['done'] };
      } catch (error) {
        await cli.reportFailure({ error, jsonRequested: opts.json === true });
        return;
      }
    },
  },
});
`,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.join('\n')).toContain("'opts' is of type 'unknown'");
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

    const forced = writeTemplateFiles({
      toolDir,
      files: rendered.files,
      force: true,
    });
    expect(forced.success).toBe(true);
    expect(existsSync(join(toolDir, 'src', 'index.ts'))).toBe(false);
    expect(existsSync(join(toolDir, 'index.mjs'))).toBe(true);
  });

  it('validates every rendered path before writing any scaffold file', () => {
    tmp = mkdtempSync(join(tmpdir(), 'ost-tools-write-'));
    const toolDir = join(tmp, 'tool-dir');

    const result = writeTemplateFiles({
      toolDir,
      files: [
        { relativePath: 'safe.txt', content: 'safe' },
        { relativePath: '../escape.txt', content: 'nope' },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.files).toEqual([]);
    expect(existsSync(join(toolDir, 'safe.txt'))).toBe(false);
  });
});
