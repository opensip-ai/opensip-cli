import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { buildWelcome, printWelcome } from '../welcome.js';

const originalEnv = { ...process.env };
const originalIsTTY = process.stdout.isTTY;

beforeEach(() => {
  delete process.env.NO_COLOR;
  delete process.env.FORCE_COLOR;
});

afterEach(() => {
  process.env = { ...originalEnv };
  Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
});

/** Pattern that matches the ANSI CSI prefix (ESC + '['). Constructed from
 * the Unicode escape so the source file stays free of literal control bytes. */
const ANSI_PATTERN = new RegExp(String.raw`${String.fromCodePoint(0x1b)}\[`);

describe('buildWelcome', () => {
  it('includes the version and primary subcommands', () => {
    const out = buildWelcome({ version: '1.2.3' });
    expect(out).toContain('OpenSIP CLI');
    expect(out).toContain('1.2.3');
    expect(out).toContain('opensip fit');
    expect(out).toContain('opensip sim');
    expect(out).toContain('opensip init');
  });

  it('emits plain text when NO_COLOR is set', () => {
    process.env.NO_COLOR = '1';
    const out = buildWelcome({ version: '1.0.0' });
    expect(out).not.toMatch(ANSI_PATTERN);
  });

  it('emits ANSI codes when FORCE_COLOR is set', () => {
    process.env.FORCE_COLOR = '1';
    delete process.env.NO_COLOR;
    const out = buildWelcome({ version: '1.0.0' });
    expect(out).toMatch(ANSI_PATTERN);
  });

  it('emits ANSI codes when stdout is a TTY', () => {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const out = buildWelcome({ version: '1.0.0' });
    expect(out).toMatch(ANSI_PATTERN);
  });

  it('emits plain text when stdout is not a TTY and no FORCE_COLOR', () => {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const out = buildWelcome({ version: '1.0.0' });
    expect(out).not.toMatch(ANSI_PATTERN);
  });
});

describe('printWelcome', () => {
  it('writes the welcome string via the supplied write callback', () => {
    const buf: string[] = [];
    printWelcome({ version: '0.1.0', write: (s) => buf.push(s) });
    expect(buf.length).toBe(1);
    expect(buf[0]).toContain('0.1.0');
  });

  it('defaults to process.stdout.write when no writer is supplied', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      printWelcome({ version: '9.9.9' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0] ?? '')).toContain('9.9.9');
    } finally {
      spy.mockRestore();
    }
  });
});
