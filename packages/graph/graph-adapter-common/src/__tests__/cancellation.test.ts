import { describe, expect, it } from 'vitest';

import { makeConfigCacheKey } from '../cache-key.js';
import { createDiscover } from '../discover.js';
import { createParseProjectFromAdapter } from '../parse-from-adapter.js';
import { runWalk } from '../walk.js';

import type { TreeSitterParsedProject } from '../parse.js';
import type { LanguageAdapter } from '@opensip-cli/core';
import type { WalkInput } from '@opensip-cli/graph';
import type { ParsedFile } from '@opensip-cli/tree-sitter';

function cancelledSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

function expectCancelled(fn: () => unknown): void {
  expect(fn).toThrow(expect.objectContaining({ code: 'CORE.SYSTEM.CANCELLED' }));
}

describe('tree-sitter adapter cancellation', () => {
  it('checks cancellation in discovery and cache-key substrates', () => {
    const signal = cancelledSignal();
    const discover = createDiscover({
      extension: 'go',
      excludedDirGlobs: [],
      configCandidates: [],
      languageId: 'go',
    });
    const cacheKey = makeConfigCacheKey({ prefix: 'go' });

    expectCancelled(() => discover({ cwd: process.cwd(), diagnosticIntent: 'quiet', signal }));
    expectCancelled(() =>
      cacheKey({ projectDirAbs: process.cwd(), resolutionMode: 'exact', signal }),
    );
  });

  it('checks cancellation in parse and walk substrates', () => {
    const signal = cancelledSignal();
    const adapter = {
      id: 'fixture',
      parse: (): ParsedFile => ({}) as ParsedFile,
    } as LanguageAdapter<ParsedFile>;
    const parseProject = createParseProjectFromAdapter(adapter);
    const walkInput: WalkInput<TreeSitterParsedProject> = {
      project: { files: new Map() },
      projectDirAbs: process.cwd(),
      files: [],
      signal,
    };

    expectCancelled(() =>
      parseProject({
        projectDirAbs: process.cwd(),
        files: [],
        resolutionMode: 'exact',
        signal,
      }),
    );
    expectCancelled(() => runWalk({ input: walkInput, walkFile: () => undefined }));
  });

  it('checks cancellation inside a language visitor checkpoint', () => {
    const controller = new AbortController();
    const path = `${process.cwd()}/fixture.go`;
    const input: WalkInput<TreeSitterParsedProject> = {
      project: { files: new Map([[path, {} as never]]) },
      projectDirAbs: process.cwd(),
      files: [path],
      signal: controller.signal,
    };

    expectCancelled(() =>
      runWalk({
        input,
        walkFile: (_path, _file, _root, _sinks, traversal): void => {
          controller.abort();
          traversal.checkpoint(1);
        },
      }),
    );
  });
});
