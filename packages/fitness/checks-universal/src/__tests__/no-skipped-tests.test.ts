/**
 * Coverage for the `no-skipped-tests` check.
 *
 * Two layers:
 *  1. The pure `analyzeSkippedTests(content, filePath)` detector — per-language
 *     positives and negatives (the caller is responsible for the isTestFile
 *     gate and string-stripping, so these tests feed already-suitable input).
 *  2. The wired `noSkippedTests` check via `Check.run(cwd, { targetFiles })`,
 *     which exercises the INVERSION (non-test files are ignored) and the
 *     `strip-strings` filter (the word "skip" inside a description string must
 *     not false-fire).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeTestScope, withScope } from '@opensip-tools/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { analyzeSkippedTests, noSkippedTests } from '../checks/testing/no-skipped-tests.js';

describe('analyzeSkippedTests (pure detector)', () => {
  it('flags .skip in a JS/TS test', () => {
    const v = analyzeSkippedTests("it.skip('x', () => {})", 'a.test.ts');
    expect(v.length).toBe(1);
    expect(v[0]?.severity).toBe('warning');
    expect(v[0]?.message).toContain('.skip');
  });

  it('flags .only as a FOCUSED test with an emphatic message', () => {
    const v = analyzeSkippedTests("describe.only('x', () => {})", 'a.test.ts');
    expect(v.length).toBe(1);
    expect(v[0]?.message).toContain('Focused');
    expect(v[0]?.message.toLowerCase()).toContain('disables every other test');
  });

  it('flags fit() / fdescribe() / xit() / xdescribe()', () => {
    const src = [
      'fit("a", () => {})',
      'fdescribe("b", () => {})',
      'xit("c", () => {})',
      'xdescribe("d", () => {})',
    ].join('\n');
    const v = analyzeSkippedTests(src, 'a.test.ts');
    expect(v.length).toBe(4);
  });

  it('flags it.todo / test.todo placeholders', () => {
    const v = analyzeSkippedTests('it.todo("later")\ntest.todo("later")', 'a.test.ts');
    expect(v.length).toBe(2);
  });

  it('reports accurate line numbers', () => {
    const v = analyzeSkippedTests('const x = 1\n\nit.skip("y", () => {})', 'a.test.ts');
    expect(v.length).toBe(1);
    expect(v[0]?.line).toBe(3);
  });

  it('does NOT flag a healthy JS/TS test', () => {
    const v = analyzeSkippedTests(
      "it('renders', () => {})\ndescribe('suite', () => {})",
      'a.test.ts',
    );
    expect(v.length).toBe(0);
  });

  it('does NOT flag bare identifiers like skipped/onlyChild', () => {
    const v = analyzeSkippedTests(
      'const skipped = 1\nconst onlyChild = 2\nlet describeIt = 3',
      'a.test.ts',
    );
    expect(v.length).toBe(0);
  });

  it('flags Python pytest/unittest skip idioms', () => {
    const src = [
      '@pytest.mark.skip',
      '@pytest.mark.skipif(True)',
      '@unittest.skip("x")',
      '@unittest.expectedFailure',
      'self.skipTest("x")',
      'pytest.skip("x")',
    ].join('\n');
    const v = analyzeSkippedTests(src, 'test_x.py');
    expect(v.length).toBe(6);
  });

  it('does NOT flag a healthy Python test', () => {
    const v = analyzeSkippedTests('def test_adds():\n    assert 1 + 1 == 2', 'test_x.py');
    expect(v.length).toBe(0);
  });

  it('flags Go t.Skip / t.Skipf / t.SkipNow', () => {
    const src = ['t.Skip("flaky")', 't.Skipf("because %d", 1)', 't.SkipNow()'].join('\n');
    const v = analyzeSkippedTests(src, 'x_test.go');
    expect(v.length).toBe(3);
  });

  it('does NOT flag a healthy Go test', () => {
    const v = analyzeSkippedTests('func TestAdds(t *testing.T) { _ = t }', 'x_test.go');
    expect(v.length).toBe(0);
  });

  it('flags the Rust #[ignore] attribute', () => {
    const v = analyzeSkippedTests('#[test]\n#[ignore]\nfn slow() {}', 'lib.rs');
    expect(v.length).toBe(1);
    expect(v[0]?.line).toBe(2);
  });

  it('does NOT flag a healthy Rust test', () => {
    const v = analyzeSkippedTests('#[test]\nfn adds() { assert_eq!(2, 1 + 1); }', 'lib.rs');
    expect(v.length).toBe(0);
  });

  it('flags Java @Disabled / @Ignore', () => {
    const v = analyzeSkippedTests('@Disabled\nvoid a() {}\n@Ignore\nvoid b() {}', 'XTest.java');
    expect(v.length).toBe(2);
  });

  it('does NOT flag a healthy Java test', () => {
    const v = analyzeSkippedTests('@Test\nvoid adds() {}', 'XTest.java');
    expect(v.length).toBe(0);
  });

  it('returns [] for an unknown extension', () => {
    const v = analyzeSkippedTests('it.skip("x", () => {})', 'a.test.kt');
    expect(v.length).toBe(0);
  });
});

describe('noSkippedTests (wired check)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'no-skipped-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function findingCount(name: string, content: string): Promise<number> {
    const filePath = join(root, name);
    await writeFile(filePath, content, 'utf8');
    const result = await withScope(makeTestScope(), () =>
      noSkippedTests.run(root, { targetFiles: [filePath] }),
    );
    return result.signals.filter((s) => s.ruleId === 'fit:no-skipped-tests').length;
  }

  it('flags .only in a test file', async () => {
    expect(
      await findingCount('widget.test.ts', "describe.only('w', () => {})"),
    ).toBeGreaterThanOrEqual(1);
  });

  it('IGNORES a non-test file (inversion) even with a .skip idiom', async () => {
    expect(await findingCount('widget.ts', "it.skip('w', () => {})")).toBe(0);
  });

  it('does NOT false-fire on the word "skip" inside a description (no idiom token present)', async () => {
    // The bare word "skip" is not an idiom token, so this is clean even before
    // string-stripping. The strip-strings filter (declared on the check) is what
    // additionally protects idiom-shaped strings like `'use describe.only'`; that
    // dispatch needs a registered language adapter and is covered by the engine's
    // content-filter-dispatch tests, not exercised here under an empty test scope.
    expect(await findingCount('widget.test.ts', "it('should skip empty input', () => {})")).toBe(0);
  });
});

describe('analyzeSkippedTests · strip-strings contract (string content pre-removed)', () => {
  it('does not match an idiom once the string content is stripped to whitespace', () => {
    // Emulate what `contentFilter: 'strip-strings'` feeds analyze in production:
    // string-literal content replaced with equal-length whitespace. The idiom
    // `describe.only` lived inside the string, so it is gone.
    const stripped = 'const note = "                          "';
    expect(analyzeSkippedTests(stripped, 'a.test.ts').length).toBe(0);
  });
});
