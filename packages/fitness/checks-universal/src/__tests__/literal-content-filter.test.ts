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
let files: string[];

function fixture(relativePath: string, content: string): string {
  const filePath = join(cwd, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  files.push(filePath);
  return filePath;
}

async function runCheck(slug: string) {
  const check = checks.find((candidate) => candidate.config.slug === slug);
  if (!check) throw new Error(`missing check: ${slug}`);
  await fitnessTestFileCache.prewarm(cwd, ['**/*']);
  return runWithScope(scope, () => check.run(cwd, { targetFiles: files }));
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'literal-filter-'));
  files = [];
});

afterEach(() => {
  fitnessTestFileCache.clear();
  rmSync(cwd, { recursive: true, force: true });
});

describe('literal-sensitive checks with production-style string filtering', () => {
  it('detects literal package specifiers in imports', async () => {
    fixture('src/heavy.ts', 'import moment from "moment";');
    const result = await runCheck('heavy-import-detection');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('ignores import examples embedded in strings', async () => {
    fixture('src/heavy.ts', String.raw`const docs = "import moment from 'moment'";`);
    const result = await runCheck('heavy-import-detection');
    expect(result.signals).toHaveLength(0);
  });

  it('uses the actual module specifier when imports contain comments', async () => {
    fixture('src/heavy.ts', 'import { value /* } from "moment" */ } from "./safe";');
    const result = await runCheck('heavy-import-detection');
    expect(result.signals).toHaveLength(0);
  });

  it('finds the source clause when imported bindings are named from', async () => {
    fixture(
      'src/heavy.ts',
      [
        'import { from } from "moment";',
        'import { from as source } from "moment";',
        'import { default as from } from "moment";',
      ].join('\n'),
    );
    const result = await runCheck('heavy-import-detection');
    expect(result.signals).toHaveLength(3);
  });

  it('distinguishes runtime bindings named type from type-only imports', async () => {
    fixture(
      'src/heavy.ts',
      [
        'import type from "moment";',
        'import { type } from "moment";',
        'import { type as thing } from "moment";',
        'import type { Moment } from "moment";',
        'import { type Moment } from "moment";',
      ].join('\n'),
    );
    const result = await runCheck('heavy-import-detection');
    expect(result.signals).toHaveLength(3);
  });

  it('detects deprecated side-effect imports', async () => {
    fixture('src/heavy.ts', 'import "moment";');
    const result = await runCheck('heavy-import-detection');
    expect(result.signals.map((signal) => signal.metadata?.type)).toEqual(['DEPRECATED_LIBRARY']);
  });

  it('uses the cooked value of an escaped module specifier', async () => {
    fixture('src/heavy.ts', String.raw`import moment from "mom\u0065nt";`);
    const result = await runCheck('heavy-import-detection');
    expect(result.signals.map((signal) => signal.metadata?.type)).toContain('DEPRECATED_LIBRARY');
  });

  it('does not truncate syntactically valid long import declarations', async () => {
    const bindings = Array.from({ length: 700 }, (_, index) => `value${index}`).join(', ');
    fixture('src/heavy.ts', `import { ${bindings} } from "moment";`);
    const result = await runCheck('heavy-import-detection');
    expect(result.signals.map((signal) => signal.metadata?.type)).toEqual(
      expect.arrayContaining(['DEPRECATED_LIBRARY', 'EXCESSIVE_NAMED_IMPORTS']),
    );
  });

  it('does not associate import-equals syntax with the following declaration', async () => {
    fixture(
      'src/heavy.ts',
      ['import legacy = require("safe")', 'import moment from "moment"'].join('\n'),
    );
    const result = await runCheck('heavy-import-detection');
    expect(
      result.signals.filter((signal) => signal.metadata?.type === 'DEPRECATED_LIBRARY'),
    ).toHaveLength(1);
  });

  it('does not associate contextual import tokens with a later export', async () => {
    fixture(
      'src/heavy.ts',
      ['const here = import.meta.url', 'obj.import', 'export { value } from "moment"'].join('\n'),
    );
    const result = await runCheck('heavy-import-detection');
    expect(result.signals).toHaveLength(0);
  });

  it('ignores import syntax embedded in regex literals', async () => {
    fixture('src/heavy.ts', 'const syntax = /import moment from "moment"/;');
    const result = await runCheck('heavy-import-detection');
    expect(result.signals).toHaveLength(0);
  });

  it('detects EventEmitter-only imports', async () => {
    fixture('src/events.ts', 'import EventEmitter, { once } from "node:events";');
    const result = await runCheck('no-custom-event-emitter');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('detects EventEmitter in mixed default and named imports', async () => {
    fixture('src/events.ts', 'import events, { EventEmitter } from "node:events";');
    const result = await runCheck('no-custom-event-emitter');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('detects EventEmitter in mixed default and namespace imports', async () => {
    fixture('src/events.ts', 'import EventEmitter, * as events from "node:events";');
    const result = await runCheck('no-custom-event-emitter');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('ignores type-only EventEmitter imports', async () => {
    fixture('src/events.ts', 'import type { EventEmitter } from "node:events";');
    const result = await runCheck('no-custom-event-emitter');
    expect(result.signals).toHaveLength(0);
  });

  it('ignores EventEmitter names inside comments in safe imports', async () => {
    fixture(
      'src/events.ts',
      'import { value /* EventEmitter } from "node:events" */ } from "./safe";',
    );
    const result = await runCheck('no-custom-event-emitter');
    expect(result.signals).toHaveLength(0);
  });

  it('ignores EventEmitter examples embedded in strings', async () => {
    fixture('src/events.ts', 'const docs = "new EventEmitter()";');
    const result = await runCheck('no-custom-event-emitter');
    expect(result.signals).toHaveLength(0);
  });

  it('detects EventEmitter usage inside executable template interpolations', async () => {
    fixture('src/events.ts', 'export const value = `${new EventEmitter()}`;');
    const result = await runCheck('no-custom-event-emitter');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('detects qualified EventEmitter construction from namespace and default imports', async () => {
    fixture(
      'src/events.ts',
      [
        'import * as nodeEvents from "node:events";',
        'import events from "events";',
        'const first = new nodeEvents.EventEmitter();',
        'const second = new events.EventEmitter();',
      ].join('\n'),
    );
    const result = await runCheck('no-custom-event-emitter');
    expect(
      result.signals.filter((signal) => signal.metadata?.type === 'new-event-emitter'),
    ).toHaveLength(2);
  });

  it('detects qualified CommonJS EventEmitter construction', async () => {
    fixture(
      'src/events.ts',
      ['const events = require("node:events");', 'const emitter = new events.EventEmitter();'].join(
        '\n',
      ),
    );
    const result = await runCheck('no-custom-event-emitter');
    expect(result.signals.map((signal) => signal.metadata?.type)).toContain('new-event-emitter');
  });

  it('detects GraphQL offset variables inside templates', async () => {
    fixture(
      'src/query.ts',
      [
        'export const query = gql`query Q($offset: Int) { items { id } }`;',
        'const docs = "$offset: Int";',
      ].join('\n'),
    );
    const result = await runCheck('graphql-offset-pagination');
    expect(result.signals).toHaveLength(1);
  });

  it('detects offset variables in generic tagged templates', async () => {
    fixture(
      'src/query.ts',
      'export const query = gql<Result>`query Q($offset: Int) { items { id } }`;',
    );
    const result = await runCheck('graphql-offset-pagination');
    expect(result.signals).toHaveLength(1);
  });

  it('matches the cooked text of GraphQL template fragments', async () => {
    fixture(
      'src/query.ts',
      'export const query = gql`query Q($offs\\u0065t: Int) { items { id } }`;',
    );
    const result = await runCheck('graphql-offset-pagination');
    expect(result.signals).toHaveLength(1);
  });

  it('detects a cooked GraphQL dollar-sign escape at its source position', async () => {
    fixture(
      'src/query.ts',
      'export const query = gql`query Q(\\u0024offset: Int) { items { id } }`;',
    );
    const result = await runCheck('graphql-offset-pagination');
    expect(result.signals).toHaveLength(1);
  });

  it('ignores commented GraphQL examples', async () => {
    fixture('src/query.ts', '// gql`query Q($offset: Int) { items { id } }`');
    const result = await runCheck('graphql-offset-pagination');
    expect(result.signals).toHaveLength(0);
  });

  it('ignores offset examples after a same-line GraphQL template closes', async () => {
    fixture(
      'src/query.ts',
      'const query = gql`query Q { items { id } }`; const docs = "$offset: Int";',
    );
    const result = await runCheck('graphql-offset-pagination');
    expect(result.signals).toHaveLength(0);
  });

  it('ignores offset examples after a multiline GraphQL template closes', async () => {
    fixture(
      'src/query.ts',
      [
        'const query = gql`',
        '  query Q { items { id } }',
        '`;',
        'const docs = "$offset: Int";',
      ].join('\n'),
    );
    const result = await runCheck('graphql-offset-pagination');
    expect(result.signals).toHaveLength(0);
  });

  it('ignores offset examples inside GraphQL interpolation expressions', async () => {
    fixture('src/query.ts', 'const query = gql`query Q { item(arg: ${pick("$offset: Int")}) }`;');
    const result = await runCheck('graphql-offset-pagination');
    expect(result.signals).toHaveLength(0);
  });

  it('keeps regex braces inside GraphQL interpolations from closing the expression', async () => {
    fixture(
      'src/query.ts',
      'const query = gql`query Q { item(arg: ${/}/.test(value) ? value : "$offset: Int"}) }`;',
    );
    const result = await runCheck('graphql-offset-pagination');
    expect(result.signals).toHaveLength(0);
  });

  it('recognizes signal handlers whose signal name is a string literal', async () => {
    fixture(
      'src/server.ts',
      ['const app = express();', 'app.listen(3000);', 'process.on("SIGTERM", shutdown);'].join(
        '\n',
      ),
    );
    const result = await runCheck('graceful-shutdown');
    expect(result.signals).toHaveLength(0);
  });

  it('recognizes once handlers and static template signal names', async () => {
    fixture(
      'src/server.ts',
      ['const app = express();', 'app.listen(3000);', 'process.once(`SIGTERM`, shutdown);'].join(
        '\n',
      ),
    );
    const result = await runCheck('graceful-shutdown');
    expect(result.signals).toHaveLength(0);
  });

  it('recognizes signal handlers across comments of arbitrary length', async () => {
    fixture(
      'src/server.ts',
      [
        'const app = express();',
        'app.listen(3000);',
        'process.on /* shutdown registration owned by the service lifecycle */ ("SIGTERM", shutdown);',
      ].join('\n'),
    );
    const result = await runCheck('graceful-shutdown');
    expect(result.signals).toHaveLength(0);
  });

  it('does not let a shutdown example in a string suppress a real finding', async () => {
    fixture(
      'src/server.ts',
      ['const app = express();', 'app.listen(3000);', 'const docs = `process.on("SIGTERM")`;'].join(
        '\n',
      ),
    );
    const result = await runCheck('graceful-shutdown');
    expect(result.signals).toHaveLength(1);
  });

  it('detects API route paths and sensitive endpoint names', async () => {
    fixture('src/routes.ts', 'app.post("/api/login", authMiddleware, handler);');
    const result = await runCheck('rate-limit-coverage');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('does not mistake route literals or comments for rate-limit configuration', async () => {
    fixture(
      'src/routes.ts',
      [
        '// app.register(rateLimit)',
        'app.get("/api/health", healthHandler);',
        'app.get("/api/throttle", handler); // /health is documented elsewhere',
      ].join('\n'),
    );
    const result = await runCheck('rate-limit-coverage');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('does not treat regex literals as rate-limit configuration', async () => {
    fixture(
      'src/routes.ts',
      ['app.get("/api/users", handler);', 'const syntax = /rateLimit/;'].join('\n'),
    );
    const result = await runCheck('rate-limit-coverage');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('recognizes multiline per-route rate-limit hooks after comments', async () => {
    fixture(
      'src/routes.ts',
      [
        'fastify.get("/api/users", {',
        '  // Per-route protection',
        '  preHandler: rateLimit,',
        '  handler,',
        '});',
      ].join('\n'),
    );
    const result = await runCheck('rate-limit-coverage');
    expect(result.signals).toHaveLength(0);
  });

  it('does not treat unrelated limiter or throttle identifiers as rate limiting', async () => {
    fixture(
      'src/routes.ts',
      [
        'app.get("/api/users", handler);',
        'const throttle = metrics.throttle;',
        'const limiter = concurrencyLimiter;',
      ].join('\n'),
    );
    const result = await runCheck('rate-limit-coverage');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('does not let a different protected route suppress an unprotected route', async () => {
    fixture(
      'src/routes.ts',
      ['app.get("/api/users", handler);', 'app.get("/api/admin", rateLimit, adminHandler);'].join(
        '\n',
      ),
    );
    const result = await runCheck('rate-limit-coverage');
    expect(result.signals.map((signal) => signal.line)).toContain(1);
    expect(result.signals.map((signal) => signal.line)).not.toContain(2);
  });

  it('does not treat rate-limit-like identifier prefixes as middleware', async () => {
    fixture(
      'src/routes.ts',
      ['app.get("/api/users", handler);', 'const rateLimitDisabled = true;'].join('\n'),
    );
    const result = await runCheck('rate-limit-coverage');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('does not apply Express middleware retroactively to earlier routes', async () => {
    fixture('src/routes.ts', ['app.get("/api/users", handler);', 'app.use(rateLimit);'].join('\n'));
    const result = await runCheck('rate-limit-coverage');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('recognizes rate-limit middleware registered before a route', async () => {
    fixture('src/routes.ts', ['app.use(rateLimit);', 'app.get("/api/users", handler);'].join('\n'));
    const result = await runCheck('rate-limit-coverage');
    expect(result.signals).toHaveLength(0);
  });

  it('does not confuse unrelated method names with global middleware registration', async () => {
    fixture(
      'src/routes.ts',
      ['abuse(rateLimit);', 'unregister(rateLimiter);', 'app.get("/api/users", handler);'].join(
        '\n',
      ),
    );
    const result = await runCheck('rate-limit-coverage');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('detects crypto package imports', async () => {
    fixture('src/password.ts', 'import bcrypt from "bcrypt";');
    const result = await runCheck('use-centralized-crypto');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('detects escaped crypto package imports by their cooked value', async () => {
    fixture('src/password.ts', String.raw`import bcrypt from "bcr\u0079pt";`);
    const result = await runCheck('use-centralized-crypto');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('ignores type-only crypto package imports', async () => {
    fixture('src/password.ts', 'import type { Options } from "bcrypt";');
    const result = await runCheck('use-centralized-crypto');
    expect(result.signals).toHaveLength(0);
  });

  it('detects static KMS dynamic imports with quote or template delimiters', async () => {
    fixture(
      'src/password.ts',
      [
        'const quoted = import("@aws-sdk/client-kms");',
        'const templated = import(`@aws-sdk/client-kms`);',
      ].join('\n'),
    );
    const result = await runCheck('use-centralized-crypto');
    expect(result.signals).toHaveLength(2);
  });

  it('matches the cooked value of a dynamic KMS import', async () => {
    fixture('src/password.ts', 'const kms = import("@aws-sdk/client-\\u006bms");');
    const result = await runCheck('use-centralized-crypto');
    expect(result.signals).toHaveLength(1);
  });

  it('detects TypeScript import-equals references to KMS', async () => {
    fixture('src/password.ts', 'import kms = require("@aws-sdk/client-kms");');
    const result = await runCheck('use-centralized-crypto');
    expect(result.signals).toHaveLength(1);
  });

  it('ignores crypto examples embedded in strings', async () => {
    fixture('src/password.ts', 'const docs = "crypto.createHash(";');
    const result = await runCheck('use-centralized-crypto');
    expect(result.signals).toHaveLength(0);
  });

  it('detects crypto usage inside executable template interpolations', async () => {
    fixture('src/password.ts', 'export const digest = `${crypto.createHash("sha256")}`;');
    const result = await runCheck('use-centralized-crypto');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('detects hardcoded webhook secrets', async () => {
    fixture('src/webhooks/stripe.ts', 'const secret = "whsec_abcdefghijklmnopqrstuvwxyz";');
    const result = await runCheck('webhook-signature-verification');
    expect(result.signals.map((signal) => signal.metadata?.type)).toContain('hardcoded-secret');
  });

  it('detects Stripe webhook secrets assigned to neutral identifiers', async () => {
    fixture('src/webhooks/stripe.ts', 'const credential = "whsec_abcdefghijklmnopqrstuvwxyz";');
    const result = await runCheck('webhook-signature-verification');
    expect(result.signals.map((signal) => signal.metadata?.type)).toContain('hardcoded-secret');
  });

  it('detects Stripe webhook secrets in template literals', async () => {
    fixture('src/webhooks/stripe.ts', 'const credential = `whsec_abcdefghijklmnopqrstuvwxyz`;');
    const result = await runCheck('webhook-signature-verification');
    expect(result.signals.map((signal) => signal.metadata?.type)).toContain('hardcoded-secret');
  });

  it('detects Stripe webhook secrets in object properties and assignments', async () => {
    fixture(
      'src/webhooks/stripe.ts',
      [
        'const config = { credential: "whsec_abcdefghijklmnopqrstuvwxyz" };',
        'config.credential = "whsec_zyxwvutsrqponmlkjihgfedcba";',
      ].join('\n'),
    );
    const result = await runCheck('webhook-signature-verification');
    expect(
      result.signals.filter((signal) => signal.metadata?.type === 'hardcoded-secret'),
    ).toHaveLength(2);
  });

  it('ignores Stripe-secret examples nested inside documentation strings', async () => {
    fixture(
      'src/webhooks/stripe.ts',
      'const docs = `configure("whsec_abcdefghijklmnopqrstuvwxyz")`;',
    );
    const result = await runCheck('webhook-signature-verification');
    expect(result.signals.map((signal) => signal.metadata?.type)).not.toContain('hardcoded-secret');
  });

  it('does not let verifier examples suppress unsafe webhook parsing', async () => {
    fixture(
      'src/webhooks/stripe.ts',
      ['const docs = "verifySignature";', 'const payload = JSON.parse(req.body);'].join('\n'),
    );
    const result = await runCheck('webhook-signature-verification');
    expect(result.signals.map((signal) => signal.metadata?.type)).toContain('missing-verification');
  });

  it('does not treat import comments as webhook verifier imports', async () => {
    fixture(
      'src/webhooks/stripe.ts',
      [
        'import { value /* } from "infrastructure/webhooks" */ } from "./safe";',
        'const payload = JSON.parse(req.body);',
      ].join('\n'),
    );
    const result = await runCheck('webhook-signature-verification');
    expect(result.signals.map((signal) => signal.metadata?.type)).toContain('missing-verification');
  });

  it('does not treat type-only imports or re-exports as webhook verifier evidence', async () => {
    fixture(
      'src/webhooks/stripe.ts',
      [
        'import type { Verifier } from "infrastructure/webhooks";',
        'export { verifySignature } from "infrastructure/webhooks";',
        'export type { VerifierOptions } from "infrastructure/webhooks";',
        'const payload = JSON.parse(req.body);',
      ].join('\n'),
    );
    const result = await runCheck('webhook-signature-verification');
    expect(result.signals.map((signal) => signal.metadata?.type)).toContain('missing-verification');
  });

  it('does not treat regex literals as webhook verifier usage', async () => {
    fixture(
      'src/webhooks/stripe.ts',
      ['const syntax = /verifySignature/;', 'const payload = JSON.parse(req.body);'].join('\n'),
    );
    const result = await runCheck('webhook-signature-verification');
    expect(result.signals.map((signal) => signal.metadata?.type)).toContain('missing-verification');
  });

  it('ignores webhook-body examples in JSON.parse strings and comments', async () => {
    fixture(
      'src/webhooks/stripe.ts',
      [
        'const fromString = JSON.parse("req.body");',
        'const fromComment = JSON.parse(payload /* req.body */);',
      ].join('\n'),
    );
    const result = await runCheck('webhook-signature-verification');
    expect(result.signals.map((signal) => signal.metadata?.type)).not.toContain(
      'missing-verification',
    );
  });

  it('ignores insecure-signature examples embedded in strings', async () => {
    fixture('src/webhooks/stripe.ts', 'const docs = "signature === expected";');
    const result = await runCheck('webhook-signature-verification');
    expect(result.signals.map((signal) => signal.metadata?.type)).not.toContain(
      'insecure-signature',
    );
  });

  it('detects the JWT none algorithm literal', async () => {
    fixture('src/jwt.ts', 'export const jwtOptions = { algorithms: ["none"] };');
    const result = await runCheck('jwt-validation');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('ignores JWT examples embedded in strings and templates', async () => {
    fixture(
      'src/jwt.ts',
      ['const docs = "jwt.verify(token, secret)";', 'const options = `algorithms: ["none"]`;'].join(
        '\n',
      ),
    );
    const result = await runCheck('jwt-validation');
    expect(result.signals).toHaveLength(0);
  });

  it('ignores commas inside JWT secret literals when counting verify arguments', async () => {
    fixture('src/jwt.ts', 'jwt.verify(token, "secret,with,commas");');
    const result = await runCheck('jwt-validation');
    expect(result.signals.some((signal) => signal.message?.includes('algorithm restriction'))).toBe(
      true,
    );
  });

  it('does not mistake algorithm-like identifiers for an algorithm option', async () => {
    fixture('src/jwt.ts', 'const jwtAlgorithmLabel = labels["none"];');
    const result = await runCheck('jwt-validation');
    expect(result.signals).toHaveLength(0);
  });

  it('does not associate none examples with unrelated JWT algorithm values', async () => {
    fixture(
      'src/jwt.ts',
      [
        'const first = { algorithms: [secureAlgorithm /* "none" */] };',
        'const second = { algorithms: secureAlgorithms, documentation: ["none"] };',
      ].join('\n'),
    );
    const result = await runCheck('jwt-validation');
    expect(result.signals).toHaveLength(0);
  });

  it('detects none in typed JWT algorithm arrays', async () => {
    fixture('src/jwt.ts', 'const jwtAlgorithms: readonly string[] = ["none"];');
    const result = await runCheck('jwt-validation');
    expect(result.signals.some((signal) => signal.message?.includes('"none"'))).toBe(true);
  });

  it('detects none after comment examples in JWT algorithm arrays', async () => {
    fixture('src/jwt.ts', 'const jwtAlgorithms = [secureAlgorithm /* "none" */, "none"];');
    const result = await runCheck('jwt-validation');
    expect(result.signals.some((signal) => signal.message?.includes('"none"'))).toBe(true);
  });

  it('detects none under quoted JWT algorithm property names', async () => {
    fixture('src/jwt.ts', 'const jwtOptions = { "algorithms": ["none"] };');
    const result = await runCheck('jwt-validation');
    expect(result.signals.some((signal) => signal.message?.includes('"none"'))).toBe(true);
  });

  it('checks every algorithm-like binding on a line', async () => {
    fixture('src/jwt.ts', 'const algorithmLabel = "secure"; const jwtAlgorithms = ["none"];');
    const result = await runCheck('jwt-validation');
    expect(result.signals.some((signal) => signal.message?.includes('"none"'))).toBe(true);
  });

  it('does not find issuer claims inside JWT secret literals', async () => {
    fixture('src/jwt.ts', 'jwt.verify(token, "mississippi", { algorithms: ["HS256"] });');
    const result = await runCheck('jwt-validation');
    expect(result.signals.some((signal) => signal.message?.includes('issuer/audience'))).toBe(true);
  });

  it('detects weak JWT secrets through transparent expression wrappers', async () => {
    fixture(
      'src/jwt.ts',
      [
        'const jwt = true;',
        'const secret = "one" as const;',
        'const jwtSecret = ("two");',
        'const options = { "secret": "three" satisfies string };',
      ].join('\n'),
    );
    const result = await runCheck('jwt-validation');
    expect(
      result.signals.filter((signal) => signal.message?.includes('appears weak')),
    ).toHaveLength(3);
  });

  it('correlates literal error codes across files', async () => {
    fixture('src/error-codes.ts', 'export const known = "APP.KNOWN.ERROR";');
    fixture('src/service.ts', 'throw { code: "APP.UNKNOWN.ERROR" };');
    const result = await runCheck('error-code-registration');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('correlates wrapped registry values and wrapped usage properties', async () => {
    fixture(
      'src/error-codes.ts',
      [
        'export const one = "APP.ONE.ERROR" as const;',
        'export const two = ("APP.TWO.ERROR");',
        'export const codes = { three: "APP.THREE.ERROR" satisfies string };',
      ].join('\n'),
    );
    fixture(
      'src/service.ts',
      [
        'consume({ code: ("APP.ONE.ERROR") });',
        'consume({ code: "APP.TWO.ERROR" as const });',
        'consume({ code: "APP.THREE.ERROR" satisfies string });',
      ].join('\n'),
    );
    const result = await runCheck('error-code-registration');
    expect(result.signals).toHaveLength(0);
  });

  it('detects raw SQL transaction literals', async () => {
    fixture('src/transaction.ts', 'export const begin = sql`BEGIN TRANSACTION`;');
    const result = await runCheck('transaction-boundary-validation');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('recognizes matching query-based SQL commit literals', async () => {
    fixture('src/transaction.ts', ['query("BEGIN TRANSACTION");', 'query("COMMIT");'].join('\n'));
    const result = await runCheck('transaction-boundary-validation');
    expect(result.signals).toHaveLength(0);
  });

  it('recognizes exec-based SQL transaction literals', async () => {
    fixture('src/transaction.ts', 'db.exec("BEGIN TRANSACTION");');
    const result = await runCheck('transaction-boundary-validation');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('recognizes matching exec-based SQL commit literals', async () => {
    fixture(
      'src/transaction.ts',
      ['db.exec("BEGIN TRANSACTION");', 'db.exec("COMMIT");'].join('\n'),
    );
    const result = await runCheck('transaction-boundary-validation');
    expect(result.signals).toHaveLength(0);
  });

  it('detects SQL transaction literals in static backtick call arguments', async () => {
    fixture('src/transaction.ts', 'db.exec(`BEGIN TRANSACTION`);');
    const result = await runCheck('transaction-boundary-validation');
    expect(result.signals.map((signal) => signal.metadata?.type)).toContain(
      'uncommitted-transaction',
    );
  });

  it('does not let an earlier completion cover a later transaction start', async () => {
    fixture('src/transaction.ts', ['db.commit();', 'db.beginTransaction();'].join('\n'));
    const result = await runCheck('transaction-boundary-validation');
    expect(result.signals.map((signal) => signal.metadata?.type)).toContain(
      'uncommitted-transaction',
    );
  });

  it('reports an uncommitted transaction after a completed transaction', async () => {
    fixture(
      'src/transaction.ts',
      ['db.beginTransaction();', 'db.commit();', 'db.beginTransaction();'].join('\n'),
    );
    const result = await runCheck('transaction-boundary-validation');
    expect(
      result.signals.filter((signal) => signal.metadata?.type === 'uncommitted-transaction'),
    ).toHaveLength(1);
  });

  it('ignores SQL transaction text inside template interpolations', async () => {
    fixture(
      'src/transaction.ts',
      [
        'const first = sql`SELECT ${"BEGIN TRANSACTION"}`;',
        'const second = sql`SELECT ${/* BEGIN TRANSACTION */ value}`;',
      ].join('\n'),
    );
    const result = await runCheck('transaction-boundary-validation');
    expect(result.signals).toHaveLength(0);
  });

  it('does not use SQL completion text inside an interpolation', async () => {
    fixture('src/transaction.ts', 'const transaction = sql`BEGIN TRANSACTION ${"COMMIT"}`;');
    const result = await runCheck('transaction-boundary-validation');
    expect(result.signals.map((signal) => signal.metadata?.type)).toContain(
      'uncommitted-transaction',
    );
  });

  it('ignores async-operation examples inside transaction strings and comments', async () => {
    fixture(
      'src/transaction.ts',
      [
        'db.beginTransaction();',
        'await work("fetch(");',
        'await work(); /* request( */',
        'await log("http");',
        'db.commit();',
      ].join('\n'),
    );
    const result = await runCheck('transaction-boundary-validation');
    expect(result.signals.map((signal) => signal.metadata?.type)).not.toContain(
      'async-in-transaction',
    );
  });

  it('detects executable async operations inside transactions', async () => {
    fixture(
      'src/transaction.ts',
      ['db.beginTransaction();', 'await fetch(url);', 'db.commit();'].join('\n'),
    );
    const result = await runCheck('transaction-boundary-validation');
    expect(result.signals.map((signal) => signal.metadata?.type)).toContain('async-in-transaction');
  });

  it('does not report async operations after a transaction completes', async () => {
    fixture(
      'src/transaction.ts',
      ['db.beginTransaction();', 'db.commit();', 'await fetch(url);'].join('\n'),
    );
    const result = await runCheck('transaction-boundary-validation');
    expect(result.signals.map((signal) => signal.metadata?.type)).not.toContain(
      'async-in-transaction',
    );
  });

  it('recognizes known-small file paths in file reads', async () => {
    fixture(
      'src/config.ts',
      'export const manifest = readFileSync("package.json", { encoding: "utf8" });',
    );
    const result = await runCheck('unbounded-memory');
    expect(result.signals).toHaveLength(0);
  });

  it('does not apply nearby known-small examples to an unrelated file read', async () => {
    fixture(
      'src/config.ts',
      [
        'const docs = "package.json";',
        '// reads package.json',
        'const manifest = "package.json";',
        'export const content = readFileSync(userPath, { encoding: "utf8" });',
      ].join('\n'),
    );
    const result = await runCheck('unbounded-memory');
    expect(result.signals.map((signal) => signal.metadata?.type)).toContain('unbounded-file-read');
  });

  it('does not apply inline known-small comments to an unrelated file read', async () => {
    fixture('src/config.ts', 'export const content = readFileSync(userPath /* package.json */);');
    const result = await runCheck('unbounded-memory');
    expect(result.signals.map((signal) => signal.metadata?.type)).toContain('unbounded-file-read');
  });

  it('detects discouraged icon-library subpath imports', async () => {
    fixture('src/Icon.tsx', 'import Icon from "react-native-vector-icons/FontAwesome";');
    const result = await runCheck('expo-vector-icons');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('matches cooked discouraged icon-library module names', async () => {
    fixture('src/Icon.tsx', 'import Icon from "react-native-vector-\\u0069cons/FontAwesome";');
    const result = await runCheck('expo-vector-icons');
    expect(result.signals).toHaveLength(1);
  });

  it('ignores type-only discouraged icon-library imports', async () => {
    fixture('src/Icon.tsx', 'import type { IconProps } from "react-icons";');
    const result = await runCheck('expo-vector-icons');
    expect(result.signals).toHaveLength(0);
  });

  it('ignores icon import examples inside multiline templates', async () => {
    fixture(
      'src/Icon.tsx',
      ['const docs = `', 'import Icon from "react-native-vector-icons/FontAwesome";', '`;'].join(
        '\n',
      ),
    );
    const result = await runCheck('expo-vector-icons');
    expect(result.signals).toHaveLength(0);
  });

  it('does not extend a safe import into a later icon example on the same line', async () => {
    fixture('src/Icon.tsx', 'import x from "./safe"; log(`import Y from "react-icons/fa"`);');
    const result = await runCheck('expo-vector-icons');
    expect(result.signals).toHaveLength(0);
  });

  it('uses the actual icon module specifier when imports contain comments', async () => {
    fixture('src/Icon.tsx', 'import { value /* } from "react-icons/fa" */ } from "./safe";');
    const result = await runCheck('expo-vector-icons');
    expect(result.signals).toHaveLength(0);
  });

  it('keeps imports between JSX closing tags visible', async () => {
    fixture(
      'src/Icon.tsx',
      [
        'const A = () => <div></div>;',
        'import Icon from "react-icons";',
        'const B = () => <span></span>;',
      ].join('\n'),
    );
    const result = await runCheck('expo-vector-icons');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('keeps imports between JSX fragment closers visible', async () => {
    fixture(
      'src/Icon.tsx',
      ['const A = () => <></>;', 'import Icon from "react-icons";', 'const B = () => <></>;'].join(
        '\n',
      ),
    );
    const result = await runCheck('expo-vector-icons');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('keeps imports between JSX identifier closers visible', async () => {
    fixture(
      'src/Icon.tsx',
      [
        'const $Foo = () => null;',
        'const A = () => <$Foo></$Foo>;',
        'import Icon from "react-icons";',
        'const B = () => <_Foo></_Foo>;',
      ].join('\n'),
    );
    const result = await runCheck('expo-vector-icons');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('recognizes TypeORM transaction completion methods', async () => {
    fixture(
      'src/transaction.ts',
      ['await queryRunner.startTransaction();', 'await queryRunner.commitTransaction();'].join(
        '\n',
      ),
    );
    const result = await runCheck('transaction-boundary-validation');
    expect(result.signals.map((signal) => signal.metadata?.type)).not.toContain(
      'uncommitted-transaction',
    );
  });

  it('recognizes canonical event infrastructure import paths', async () => {
    fixture(
      'src/publisher.ts',
      [
        'import { publish } from "./infrastructure/events/index.js";',
        'manager.emit("created", payload);',
      ].join('\n'),
    );
    const result = await runCheck('event-architecture');
    expect(result.signals).toHaveLength(0);
  });

  it('detects direct EventEmitter usage despite a canonical-path string example', async () => {
    fixture(
      'src/publisher.ts',
      ['const docs = "infrastructure/events";', 'const emitter = new EventEmitter();'].join('\n'),
    );
    const result = await runCheck('event-architecture');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('does not treat import comments as proper event infrastructure', async () => {
    fixture(
      'src/publisher.ts',
      [
        'import { value /* eventEmitter } from "infrastructure/events" */ } from "./safe";',
        'const emitter = new EventEmitter();',
      ].join('\n'),
    );
    const result = await runCheck('event-architecture');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('does not treat regex literals as proper event infrastructure', async () => {
    fixture(
      'src/publisher.ts',
      ['const syntax = /eventBus/;', 'const emitter = new EventEmitter();'].join('\n'),
    );
    const result = await runCheck('event-architecture');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('does not treat a Node EventEmitter import as canonical event infrastructure', async () => {
    fixture(
      'src/publisher.ts',
      ['import { EventEmitter } from "node:events";', 'const emitter = new EventEmitter();'].join(
        '\n',
      ),
    );
    const result = await runCheck('event-architecture');
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('detects qualified Node EventEmitter construction in event architecture', async () => {
    fixture(
      'src/publisher.ts',
      ['const events = require("node:events");', 'const emitter = new events.EventEmitter();'].join(
        '\n',
      ),
    );
    const result = await runCheck('event-architecture');
    expect(result.signals.length).toBeGreaterThan(0);
  });
});
