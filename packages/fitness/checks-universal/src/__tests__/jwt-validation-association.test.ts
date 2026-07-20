import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { LanguageRegistry, RunScope, runWithScope } from '@opensip-cli/core';
import { typescriptAdapter } from '@opensip-cli/lang-typescript';
import { fitnessTestFileCache } from '@opensip-cli/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checks } from '../index.js';

const languages = new LanguageRegistry();
languages.register(typescriptAdapter);
const scope = new RunScope({ languages });
Object.assign(scope, { fitness: { fileCache: fitnessTestFileCache } });

let cwd: string;

async function runJwtCheck(content: string) {
  const filePath = join(cwd, 'src/jwt.ts');
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  await fitnessTestFileCache.prewarm(cwd, ['**/*']);
  const check = checks.find((candidate) => candidate.config.slug === 'jwt-validation');
  if (!check) throw new Error('missing jwt-validation check');
  return runWithScope(scope, () => check.run(cwd, { targetFiles: [filePath] }));
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'jwt-association-'));
});

afterEach(() => {
  fitnessTestFileCache.clear();
  rmSync(cwd, { recursive: true, force: true });
});

describe('jwt-validation syntax association', () => {
  it('does not associate unrelated later arrays with algorithm names', async () => {
    const result = await runJwtCheck(
      [
        'log(jwtAlgorithm, { other: ["none"] });',
        'consume(jwtAlgorithm); const other = ["none"];',
      ].join('\n'),
    );

    expect(result.signals.some((signal) => signal.message?.includes('"none"'))).toBe(false);
  });

  it('finds executable weak secrets after comment and template examples', async () => {
    const result = await runJwtCheck(
      [
        '/* jwtSecret = "documented" */ const jwtSecret = "short";',
        'const docs = `secret = "documented"`; const secret = "tiny";',
      ].join('\n'),
    );

    expect(
      result.signals.filter((signal) => signal.message?.includes('appears weak')),
    ).toHaveLength(2);
  });

  it('does not let a later issuer declaration satisfy a verify call', async () => {
    const result = await runJwtCheck(
      'jwt.verify(token, secret, { algorithms: ["HS256"] }); const issuer = "trusted";',
    );

    expect(result.signals.some((signal) => signal.message?.includes('issuer/audience'))).toBe(true);
  });

  it('checks an insecure verify call after a safe verify call on the same line', async () => {
    const result = await runJwtCheck(
      [
        'jwt.verify(first, secret, { algorithms: ["HS256"], issuer: "trusted" });',
        'jwt.verify(second, secret);',
      ].join(' '),
    );

    expect(
      result.signals.filter((signal) => signal.message?.includes('algorithm restriction')),
    ).toHaveLength(1);
  });

  it('checks issuer and audience on every verify call on the same line', async () => {
    const result = await runJwtCheck(
      [
        'jwt.verify(first, secret, { algorithms: ["HS256"], issuer: "trusted" });',
        'jwt.verify(second, secret, { algorithms: ["HS256"] });',
      ].join(' '),
    );

    expect(
      result.signals.filter((signal) => signal.message?.includes('issuer/audience')),
    ).toHaveLength(1);
  });

  it('checks multiline verify calls and multiline algorithm arrays', async () => {
    const result = await runJwtCheck(
      [
        'jwt.verify(',
        '  token,',
        '  secret',
        ');',
        'const jwtAlgorithms = [',
        '  "none",',
        '];',
      ].join('\n'),
    );

    expect(
      result.signals.filter((signal) => signal.message?.includes('algorithm restriction')),
    ).toHaveLength(1);
    expect(result.signals.filter((signal) => signal.message?.includes('"none"'))).toHaveLength(1);
  });

  it('requires issuer or audience at the top level of multiline options', async () => {
    const result = await runJwtCheck(
      [
        'jwt.verify(',
        '  token,',
        '  secret,',
        '  { algorithms: ["HS256"], metadata: { issuer: "docs" } },',
        ');',
        'jwt.verify(token, secret, { algorithms: ["HS256"], audience: "api" });',
      ].join('\n'),
    );

    expect(
      result.signals.filter((signal) => signal.message?.includes('issuer/audience')),
    ).toHaveLength(1);
  });

  it('recognizes two-argument verify calls through supported TypeScript syntax', async () => {
    const result = await runJwtCheck(
      [
        'jwt.verify(token, secret,);',
        'jwt.verify<Token>(token, secret);',
        'jwt?.verify(token, secret);',
        'jwt!.verify(token, secret);',
        '(jwt).verify(token, secret);',
        '(jwt.verify)(token, secret);',
        'jwt["verify"](token, secret);',
        'jwt.verify?.(token, secret);',
        'jwt?.["verify"]?.(token, secret);',
        'jwt["ver\\u0069fy"](token, secret);',
        'other.verify(token, secret);',
        'jwt["verification"](token, secret);',
        'const docs = "jwt.verify(token, secret)";',
        '/* jwt?.verify(token, secret); */',
      ].join('\n'),
    );

    expect(
      result.signals.filter((signal) => signal.message?.includes('algorithm restriction')),
    ).toHaveLength(10);
  });

  it('finds none only in structurally associated algorithm arrays', async () => {
    const result = await runJwtCheck(
      [
        'const config = { ["algor\\u0069thms"]: (["none"] as const) };',
        'const jwtAlgorithms = ["no\\u006ee"];',
        'jwtOptions["algorithms"] = (([`NONE`] as const));',
        'const unrelated = ["none"];',
        'const algorithmKey = "algorithms";',
        'const dynamic = { [algorithmKey]: ["none"], modes: ["none"] };',
        'const docs = `algorithms: ["none"]`;',
      ].join('\n'),
    );

    expect(result.signals.filter((signal) => signal.message?.includes('"none"'))).toHaveLength(3);
  });

  it('uses only static top-level issuer or audience properties', async () => {
    const result = await runJwtCheck(
      [
        'jwt?.verify<Token>(',
        '  token,',
        '  secret,',
        '  ({ algorithms: ["HS256"], metadata: { issuer: "nested" } } as const),',
        ');',
        '(jwt.verify)(token, secret, ({ algorithms: ["HS256"], ["aud\\u0069ence"]: "api" }));',
        'const issuerKey = "issuer";',
        'jwt["verify"](token, secret, { algorithms: ["HS256"], [issuerKey]: "dynamic" });',
      ].join('\n'),
    );

    expect(
      result.signals.filter((signal) => signal.message?.includes('issuer/audience')),
    ).toHaveLength(2);
  });
});
