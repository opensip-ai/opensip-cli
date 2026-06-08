import { renderToText } from '@opensip-tools/cli-ui';
import { describe, it, expect } from 'vitest';

import { resultToView } from '../result-to-view.js';

import type { CommandResult } from '@opensip-tools/contracts';

const text = (r: CommandResult): string => renderToText(resultToView(r));

describe('list-checks view', () => {
  it('groups by tag (sorted), falls back to untagged, lists slugs + descriptions', () => {
    const out = text({
      type: 'list-checks',
      totalCount: 2,
      checks: [
        { slug: 'no-console', description: 'no console', tags: ['quality'] },
        { slug: 'loose', description: 'untagged check', tags: [] },
      ],
    });
    expect(out).toContain('Available Fitness Checks (2 total)');
    expect(out).toContain('quality (1)');
    expect(out).toContain('untagged (1)');
    expect(out).toContain('no-console — no console');
  });
});

describe('list-recipes view', () => {
  it('lists recipe name, description, and check count', () => {
    const out = text({ type: 'list-recipes', recipes: [{ name: 'example', description: 'demo recipe', checkCount: '5 checks' }] });
    expect(out).toContain('Available Recipes');
    expect(out).toContain('example — demo recipe (5 checks)');
  });
});

describe('history view', () => {
  it('renders the empty state', () => {
    expect(text({ type: 'history', sessions: [] })).toContain('No sessions recorded yet');
  });

  it('renders rows with score, PASS/FAIL, counts, recipe, duration', () => {
    const out = text({
      type: 'history',
      sessions: [
        { id: 'FIT_1', tool: 'fit', timestamp: '2026-01-01T00:00:00.000Z', score: 95, passed: true, durationMs: 1500, recipe: 'example', payload: { summary: { passed: 9, total: 10 } }, showCommand: 'opensip-tools sessions show FIT_1 --json' } as never,
        { id: 'GRAPH_2', tool: 'graph', timestamp: '2026-01-02T00:00:00.000Z', score: 40, passed: false, durationMs: 500, payload: {}, showCommand: 'opensip-tools sessions show GRAPH_2 --json' } as never,
      ],
    });
    expect(out).toContain('Run History (2 sessions)');
    expect(out).toContain('FIT_1');
    expect(out).toContain('fit');
    expect(out).toContain('GRAPH_2');
    expect(out).toContain('graph');
    expect(out).toContain('95%');
    expect(out).toContain('PASS');
    expect(out).toContain('9/10 checks');
    expect(out).toContain('(example)');
    expect(out).toContain('40%');
    expect(out).toContain('FAIL');
  });
});

describe('experimental + help + dashboard views', () => {
  it('renders the experimental sim notice', () => {
    const out = text({ type: 'experimental', tool: 'sim', cwd: '/x' });
    expect(out).toContain('Simulation');
    expect(out).toContain('Under active development');
  });

  it('renders help commands', () => {
    expect(text({ type: 'help' })).toContain('Run fitness checks');
  });

  it('renders dashboard opened / not-opened', () => {
    expect(text({ type: 'dashboard', path: '/r.html', opened: true })).toContain('Opened in browser.');
    expect(text({ type: 'dashboard', path: '/r.html', opened: false })).toContain('Open the file in your browser');
  });
});

describe('clear/configure/uninstall done views', () => {
  it('clear-done: empty / cancelled / done', () => {
    expect(text({ type: 'clear-done', action: 'empty', deletedCount: 0, sessionCount: 0 })).toContain('No session data');
    expect(text({ type: 'clear-done', action: 'cancelled', deletedCount: 0, sessionCount: 3 })).toContain('Cancelled');
    expect(text({ type: 'clear-done', action: 'done', deletedCount: 1, sessionCount: 1 })).toContain('1 session deleted.');
  });

  it('configure-done: saved / cancelled', () => {
    expect(text({ type: 'configure-done', action: 'saved', configPath: '/c.yml' })).toContain('API key saved to /c.yml');
    expect(text({ type: 'configure-done', action: 'cancelled', configPath: '/c.yml' })).toContain('No key provided');
  });

  it('uninstall-done: removed / dry-run / empty / cancelled', () => {
    const base = { type: 'uninstall-done', mode: 'user', rootPath: '/r', sizeBytes: 2048 } as const;
    expect(text({ ...base, action: 'removed', targets: [{ path: '/r/a', kind: 'file' }] })).toContain('Removed 1 target');
    expect(text({ ...base, action: 'dry-run', targets: [{ path: '/r/a', kind: 'file' }] })).toContain('[dry-run]');
    expect(text({ ...base, action: 'empty', targets: [] })).toContain('Nothing to remove');
    expect(text({ ...base, action: 'cancelled', targets: [] })).toContain('Cancelled');
  });
});

describe('init view', () => {
  const base = { type: 'init', created: true, path: '/p/cfg.yml', cwd: '/p', configFilename: 'opensip-tools.config.yml' } as const;

  it('renders the pristine success scaffold with created files + try-it hints', () => {
    const out = text({ ...base, state: 'pristine', languages: ['typescript'], createdFiles: ['/p/opensip-tools/x.ts'], gitignoreUpdated: true });
    expect(out).toContain('Scaffolded for typescript');
    expect(out).toContain('opensip-tools/x.ts');
    expect(out).toContain('.gitignore');
    expect(out).toContain('opensip-tools fit --recipe example');
  });

  it('renders the inside-existing-project refusal verbatim', () => {
    const out = text({ ...base, created: false, insideExistingProject: { discoveredRoot: '/p', message: 'line one\nline two' } });
    expect(out).toContain('line one');
    expect(out).toContain('line two');
  });

  it('renders the ambiguous-language refusal', () => {
    const out = text({ ...base, created: false, ambiguousLanguageError: { detected: ['ts', 'py'], message: 'pass --language' } });
    expect(out).toContain('language ambiguous');
    expect(out).toContain('pass --language');
  });

  it('renders the partial-state refusal with file classifications + flag hints', () => {
    const out = text({
      ...base,
      created: false,
      partialStateError: {
        state: 'partial-dir-only',
        preExistingFiles: [{ path: '/p/opensip-tools/c.ts', classification: 'custom' }],
        message: 'm',
      },
    });
    expect(out).toContain('opensip-tools/ present but');
    expect(out).toContain('(custom)');
    expect(out).toContain('opensip-tools init --keep');
    expect(out).toContain('opensip-tools init --remove');
  });

  it('renders the creation-failure fallback', () => {
    expect(text({ ...base, created: false })).toContain('Failed to scaffold');
  });
});

describe('plugin view', () => {
  it('list: with plugins and the empty domains', () => {
    const out = text({
      type: 'plugin-list',
      totalCount: 1,
      plugins: [{ domain: 'fit', namespace: 'acme', pluginType: 'package' }],
      toolProvenance: [],
    });
    expect(out).toContain('Installed Plugins');
    expect(out).toContain('fit/');
    expect(out).toContain('acme');
    expect(out).toContain('sim/'); // empty domain line
  });

  it('list: totally empty shows the get-started hint', () => {
    expect(text({ type: 'plugin-list', totalCount: 0, plugins: [], toolProvenance: [] })).toContain(
      'No plugins installed',
    );
  });

  it('list: renders the tool-provenance section (source + short manifestHash)', () => {
    const out = text({
      type: 'plugin-list',
      totalCount: 0,
      plugins: [],
      toolProvenance: [
        {
          source: 'bundled',
          id: 'fit',
          version: '2.8.0',
          packageName: '@opensip-tools/fitness',
          resolvedPath: '/pkgs/fitness',
          manifestHash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        },
      ],
    });
    expect(out).toContain('Tools (provenance)');
    expect(out).toContain('fit');
    expect(out).toContain('[bundled]');
    expect(out).toContain('abcdef012345'); // 12-char short hash
    expect(out).toContain('@opensip-tools/fitness');
  });

  it('add / remove success and failure', () => {
    expect(text({ type: 'plugin-add', packageName: 'p', success: true })).toContain('Installed p');
    expect(text({ type: 'plugin-add', packageName: 'p', success: false, error: 'eperm' })).toContain('Failed to install p (eperm)');
    expect(text({ type: 'plugin-remove', packageName: 'p', success: true })).toContain('Removed p');
  });

  it('sync: empty / populated with errors', () => {
    expect(text({ type: 'plugin-sync', synced: [], success: true })).toContain('No plugins declared');
    const out = text({
      type: 'plugin-sync',
      synced: [{ domain: 'fit', package: 'a', installed: true }, { domain: 'sim', package: 'b', installed: false }],
      success: false,
      errors: ['b failed'],
    });
    expect(out).toContain('Plugin sync');
    expect(out).toContain('fit/a');
    expect(out).toContain('b failed');
    expect(out).toContain('One or more plugins failed');
  });
});
