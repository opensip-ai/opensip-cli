import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isCapabilityFilesystemPathAllowed } from '../capability-worker/guards.js';

describe('capability worker filesystem guard', () => {
  it('checks every Node PathLike form against the allowed roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'opensip-capability-guard-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'opensip-capability-guard-outside-'));
    try {
      const roots = [root];
      const insidePath = join(root, 'allowed.txt');
      const outsidePath = join(outside, 'denied.txt');

      expect(isCapabilityFilesystemPathAllowed(insidePath, roots)).toBe(true);
      expect(isCapabilityFilesystemPathAllowed(pathToFileURL(insidePath), roots)).toBe(true);
      expect(isCapabilityFilesystemPathAllowed(Buffer.from(insidePath), roots)).toBe(true);

      expect(isCapabilityFilesystemPathAllowed(outsidePath, roots)).toBe(false);
      expect(isCapabilityFilesystemPathAllowed(pathToFileURL(outsidePath), roots)).toBe(false);
      expect(isCapabilityFilesystemPathAllowed(Buffer.from(outsidePath), roots)).toBe(false);

      expect(isCapabilityFilesystemPathAllowed(0, roots)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('denies a symlink escape from inside the allowed root (realpath containment)', () => {
    const root = mkdtempSync(join(tmpdir(), 'opensip-capability-guard-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'opensip-capability-guard-outside-'));
    try {
      // A link INSIDE the root pointing OUTSIDE it — the old logical
      // resolve()+startsWith check admitted this; realpath containment must not.
      const link = join(root, 'escape');
      symlinkSync(outside, link, 'dir');
      expect(isCapabilityFilesystemPathAllowed(join(link, 'denied.txt'), [root])).toBe(false);
      expect(isCapabilityFilesystemPathAllowed(link, [root])).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('allows creating a new file (missing leaf) inside the root, denies one outside', () => {
    const root = mkdtempSync(join(tmpdir(), 'opensip-capability-guard-root-'));
    try {
      // Deepest existing ancestor is the root itself; the missing suffix
      // cannot contain a symlink.
      expect(isCapabilityFilesystemPathAllowed(join(root, 'new-file.txt'), [root])).toBe(true);
      expect(
        isCapabilityFilesystemPathAllowed(join(root, 'new-dir', 'deep', 'file.txt'), [root]),
      ).toBe(true);
      expect(
        isCapabilityFilesystemPathAllowed(join(tmpdir(), 'nonexistent-xyz', 'f.txt'), [root]),
      ).toBe(false);
      // A traversal that lexically escapes through a missing dir is denied.
      expect(
        isCapabilityFilesystemPathAllowed(join(root, 'missing', '..', '..', 'f.txt'), [root]),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks containment at the deepest existing ancestor when it is a subdirectory', () => {
    const root = mkdtempSync(join(tmpdir(), 'opensip-capability-guard-root-'));
    try {
      mkdirSync(join(root, 'sub'));
      expect(
        isCapabilityFilesystemPathAllowed(join(root, 'sub', 'new', 'file.txt'), [root]),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
