import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { statSyncMock } = vi.hoisted(() => ({ statSyncMock: vi.fn() }));

vi.mock('node:fs', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- Vitest typed importOriginal requires a module import type expression.
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: (...args: Parameters<typeof actual.statSync>) => statSyncMock(...args),
  };
});

import { boundProjectLanguages, discoverFiles } from './inventory-files.js';
import { DEFAULT_INVENTORY_LIMITS, MAX_FILE_LANGUAGES, MAX_PROJECT_LANGUAGES } from './types.js';

import type { FileFact } from '@opensip-cli/contracts';
import type {
  BoundedTargetMembershipResolver,
  BoundedTargetResolution,
  BoundedTargetResolutionOptions,
  TargetView,
} from '@opensip-cli/core';

const roots: string[] = [];

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'opensip-inventory-files-')));
  roots.push(root);
  return root;
}

function writeSource(root: string, relativePath: string, contents = 'source'): string {
  const file = join(root, relativePath);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

function target(name: string, extra: Partial<TargetView['config']> = {}): TargetView {
  return {
    config: {
      name,
      description: name,
      include: ['**/*'],
      exclude: [],
      ...extra,
    },
  };
}

class FileTargets implements BoundedTargetMembershipResolver {
  readonly globalExcludes: readonly string[] = [];

  constructor(
    private readonly definitions: readonly TargetView[],
    private readonly files: Readonly<Record<string, readonly string[]>>,
  ) {}

  getByName(name: string): TargetView | undefined {
    return this.definitions.find((candidate) => candidate.config.name === name);
  }

  getAll(): readonly TargetView[] {
    return this.definitions;
  }

  getByTag(): readonly TargetView[] {
    return [];
  }

  has(name: string): boolean {
    return this.getByName(name) !== undefined;
  }

  resolveTargets(names: readonly string[]): readonly string[] {
    return names.flatMap((name) => this.files[name] ?? []);
  }

  resolveTargetsBounded(
    names: readonly string[],
    _rootDir: string,
    options: BoundedTargetResolutionOptions,
  ): Promise<BoundedTargetResolution> {
    const files = [...new Set(names.flatMap((name) => this.files[name] ?? []))];
    return Promise.resolve({
      files: files.slice(0, options.maxResults),
      capped: files.length > options.maxResults,
      cancelled: options.signal?.aborted === true,
    });
  }

  resolveTargetMembershipsBounded(
    names: readonly string[],
    _rootDir: string,
    options: BoundedTargetResolutionOptions & { maxTargetsPerFile: number },
  ) {
    const targetNamesByFile = new Map<string, Set<string>>();
    for (const name of names) {
      for (const file of this.files[name] ?? []) {
        const set = targetNamesByFile.get(file) ?? new Set<string>();
        set.add(name);
        targetNamesByFile.set(file, set);
      }
    }
    const memberships = [...targetNamesByFile.entries()].map(([filePath, targetNames]) => ({
      filePath,
      targetNames: [...targetNames],
    }));
    return Promise.resolve({
      memberships: memberships.slice(0, options.maxResults),
      capped: memberships.length > options.maxResults,
      membershipCapped: false,
      cancelled: options.signal?.aborted === true,
    });
  }

  applyGlobalExcludes(files: readonly string[]): readonly string[] {
    return files;
  }

  applyGlobalExcludesBounded(
    files: readonly string[],
    _rootDir: string,
    options: BoundedTargetResolutionOptions,
  ): Promise<BoundedTargetResolution> {
    return Promise.resolve({
      files: files.slice(0, options.maxResults),
      capped: files.length > options.maxResults,
      cancelled: options.signal?.aborted === true,
    });
  }
}

function fileFact(path: string, languages: readonly string[]): FileFact {
  return {
    path,
    size: 1,
    modifiedMs: 1,
    roles: ['unknown'],
    targets: ['source'],
    languages,
    evidenceSupport: {
      callable: 'unknown',
      declaration: 'unknown',
      reference: 'unknown',
    },
    provenance: [{ source: 'filesystem', detail: 'stat-metadata' }],
  };
}

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  statSyncMock.mockImplementation((...args: Parameters<typeof actual.statSync>) =>
    actual.statSync(...args),
  );
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  statSyncMock.mockReset();
});

describe('boundProjectLanguages', () => {
  it('returns files unchanged when project languages fit the hard ceiling', () => {
    const reasons = new Set<string>();
    const files = [fileFact('a.ts', ['typescript']), fileFact('b.ts', ['go'])];
    expect(boundProjectLanguages(files, { projectRoot: '/', configIdentity: 'cfg' }, reasons)).toBe(
      files,
    );
    expect([...reasons]).toEqual([]);
  });

  it('truncates project languages and recomputes evidence support under the cap', () => {
    const languages = Array.from(
      { length: MAX_PROJECT_LANGUAGES + 3 },
      (_, index) => `lang-${String(index).padStart(3, '0')}`,
    );
    const reasons = new Set<string>();
    const input = {
      projectRoot: '/',
      configIdentity: 'cfg',
      languageEvidenceSupport: new Map(
        languages.map((language) => [
          language,
          {
            callable: 'unsupported' as const,
            declaration: 'unsupported' as const,
            reference: 'unsupported' as const,
          },
        ]),
      ),
    };
    const files = [
      fileFact('a.ts', languages.slice(0, 40)),
      fileFact('b.ts', languages.slice(40)),
    ];

    const bounded = boundProjectLanguages(files, input, reasons);
    const retained = new Set(languages.slice(0, MAX_PROJECT_LANGUAGES));

    expect(reasons.has('project-language-cap-reached')).toBe(true);
    expect(bounded).toHaveLength(2);
    for (const file of bounded) {
      expect(file.languages.every((language) => retained.has(language))).toBe(true);
      expect(file.evidenceSupport).toEqual({
        callable: 'unsupported',
        declaration: 'unsupported',
        reference: 'unsupported',
      });
    }
  });
});

describe('discoverFiles materialization edge cases', () => {
  it('caps per-file languages and projects mixed evidence support', async () => {
    const root = tempRoot();
    const path = writeSource(root, 'src/a.ts');
    const languages = Array.from(
      { length: MAX_FILE_LANGUAGES + 2 },
      (_, index) => `lang-${String(index).padStart(2, '0')}`,
    );
    const support = new Map(
      languages.map((language, index) => [
        language,
        {
          callable:
            index === 0 ? ('supported' as const) : index === 1 ? ('unsupported' as const) : undefined,
          declaration: 'unsupported' as const,
          reference: undefined,
        },
      ]),
    );
    const targets = new FileTargets([target('source', { languages })], { source: [path] });

    const discovery = await discoverFiles({
      inventoryInput: {
        projectRoot: root,
        configIdentity: 'cfg',
        targets,
        languageEvidenceSupport: support,
      },
      limits: DEFAULT_INVENTORY_LIMITS,
      manifests: [],
      packages: [{ name: 'root', root: '.', private: false, exports: [], bins: [], verificationCommands: [], provenance: [] }],
      projectRoot: root,
      resolver: targets,
    });

    expect(discovery.reasons).toContain('file-language-cap-reached');
    const file = discovery.files.find((candidate) => candidate.path === 'src/a.ts');
    expect(file?.languages).toHaveLength(MAX_FILE_LANGUAGES);
    expect(file?.packageName).toBe('root');
    expect(file?.evidenceSupport.callable).toBe('supported');
    expect(file?.evidenceSupport.declaration).toBe('unsupported');
    expect(file?.evidenceSupport.reference).toBe('unknown');
  });

  it('marks stat failures as metadata read failures after resolution', async () => {
    const root = tempRoot();
    const path = writeSource(root, 'src/a.ts');
    const targets = new FileTargets([target('source', { languages: ['typescript'] })], {
      source: [path],
    });
    statSyncMock.mockImplementation(() => {
      throw new Error('simulated stat failure');
    });

    const discovery = await discoverFiles({
      inventoryInput: {
        projectRoot: root,
        configIdentity: 'cfg',
        targets,
      },
      limits: DEFAULT_INVENTORY_LIMITS,
      manifests: [],
      packages: [],
      projectRoot: root,
      resolver: targets,
    });

    expect(discovery.files).toEqual([]);
    expect(discovery.reasons).toContain('file-metadata-read-failed');
  });

  it('projects all-unsupported language evidence as unsupported', async () => {
    const root = tempRoot();
    const path = writeSource(root, 'src/a.ts');
    const targets = new FileTargets([target('source', { languages: ['go', 'rust'] })], {
      source: [path],
    });

    const discovery = await discoverFiles({
      inventoryInput: {
        projectRoot: root,
        configIdentity: 'cfg',
        targets,
        languageEvidenceSupport: new Map([
          [
            'go',
            {
              callable: 'unsupported',
              declaration: 'unsupported',
              reference: 'unsupported',
            },
          ],
          [
            'rust',
            {
              callable: 'unsupported',
              declaration: 'unsupported',
              reference: 'unsupported',
            },
          ],
        ]),
      },
      limits: DEFAULT_INVENTORY_LIMITS,
      manifests: [],
      packages: [],
      projectRoot: root,
      resolver: targets,
    });

    expect(discovery.files[0]?.evidenceSupport).toEqual({
      callable: 'unsupported',
      declaration: 'unsupported',
      reference: 'unsupported',
    });
  });

  it('stops materialization when cancellation is observed mid-batch', async () => {
    const root = tempRoot();
    const files = Array.from({ length: 70 }, (_, index) =>
      writeSource(root, `src/f-${String(index).padStart(2, '0')}.ts`),
    );
    let checks = 0;
    const signal = {
      get aborted() {
        checks += 1;
        return checks > 30;
      },
    } as AbortSignal;
    const targets = new FileTargets([target('source', { languages: ['typescript'] })], {
      source: files,
    });

    const discovery = await discoverFiles({
      inventoryInput: {
        projectRoot: root,
        configIdentity: 'cfg',
        targets,
        signal,
      },
      limits: DEFAULT_INVENTORY_LIMITS,
      manifests: [],
      packages: [],
      projectRoot: root,
      resolver: targets,
    });

    expect(discovery.files.length).toBeLessThan(files.length);
    expect(discovery.reasons).toContain('inventory-cancelled');
  });
});
