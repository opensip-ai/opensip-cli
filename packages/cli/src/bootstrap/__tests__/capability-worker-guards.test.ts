import { mkdtempSync, rmSync } from 'node:fs';
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
});
