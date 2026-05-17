/**
 * Editor deep-link URL generator tests.
 */

import { describe, expect, it } from 'vitest';

import { dashboardEditorLinkJs } from '../persistence/dashboard/code-paths/editor-link.js';

function loadEditorLink(protocol: string | null): (filePath: string, line: number) => string | null {
  const protoSrc = protocol === null
    ? 'var EDITOR_PROTOCOL = null;'
    : 'var EDITOR_PROTOCOL = ' + JSON.stringify(protocol) + ';';
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source.
  const fn = new Function(protoSrc + dashboardEditorLinkJs() + '\nreturn editorLinkUrl;')() as (f: string, l: number) => string | null;
  return fn;
}

describe('editorLinkUrl', () => {
  it('produces vscode://file/<path>:<line> for vscode', () => {
    const f = loadEditorLink('vscode');
    expect(f('packages/x/src/x.ts', 42)).toBe('vscode://file/packages/x/src/x.ts:42');
  });

  it('produces cursor://file/<path>:<line> for cursor', () => {
    const f = loadEditorLink('cursor');
    expect(f('packages/x/src/x.ts', 7)).toBe('cursor://file/packages/x/src/x.ts:7');
  });

  it('returns null when EDITOR_PROTOCOL is null', () => {
    const f = loadEditorLink(null);
    expect(f('packages/x/src/x.ts', 1)).toBeNull();
  });

  it('returns null for an unrecognized protocol', () => {
    const f = loadEditorLink('mystery');
    expect(f('packages/x/src/x.ts', 1)).toBeNull();
  });

  it('falls back to line 1 when no line is provided', () => {
    const f = loadEditorLink('vscode');
    expect(f('packages/x/src/x.ts', 0)).toBe('vscode://file/packages/x/src/x.ts:1');
  });
});
