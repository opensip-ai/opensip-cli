/**
 * @fileoverview Parametric coverage for every check in this pack.
 *
 * Drives each check's `run()` method against a fixture project that
 * contains content likely to trip its detection (e.g. an `EXAMPLE_TODO`
 * marker, a `console.log` line, a `process.env.X` reference, etc.).
 * The goal is execution coverage of the analyze paths, not exhaustive
 * detection-correctness assertions — those belong in per-check
 * dedicated tests where the user cares about a specific signal.
 *
 * What this file *does* assert: every registered check runs to
 * completion without throwing, returns a CheckResult with the expected
 * shape, and produces a number of signals consistent with its config
 * (errors >= 0, warnings >= 0).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { fileCache } from '@opensip-tools/fitness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checks } from '../index.js';

let cwd: string;
let allFixturePaths: string[] = [];

function fixture(rel: string, content: string): string {
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

beforeAll(async () => {
   
  cwd = mkdtempSync(join(tmpdir(), 'opensip-universal-cov-'));

  // Curated fixture corpus designed to trip many checks at once. Each
  // check that runs sees the same fixture set; checks whose detections
  // need different content can override.
  allFixturePaths = [
    fixture('package.json', JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      dependencies: { 'lodash': '^4.0.0', 'express': '^4.18.0' },
      devDependencies: { 'typescript': '^5.0.0', 'vitest': '^2.0.0' },
      scripts: { test: 'vitest', start: 'node src/app.ts' },
    }, null, 2)),
    fixture('src/app.ts', [
      'import process from "node:process";',
      'console.log("hello"); // EXAMPLE_TODO debug',
      'const apiKey = "sk_live_12345678901234567890";',
      'const port = process.env.PORT;',
      'eval("1 + 1");',
      'window.alert("hi");',
      'setTimeout(() => {}, 30000);',
      'const conn = setInterval(() => {}, 60000);',
      'export function greet(name: string): string {',
      '  return `hello ${name}`;',
      '}',
      'try { foo() } catch (e) { e.printStackTrace?.(); }',
    ].join('\n')),
    fixture('src/lib/util.ts', [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      'export function divide(a: number, b: number): number {',
      '  return a / b;',
      '}',
    ].join('\n')),
    fixture('src/api/handler.ts', [
      'import express from "express";',
      'import { getUser, deleteUser } from "./db.js";',
      'const router = express.Router();',
      'router.get("/users/:id", async (req, res) => {',
      '  const sql = `SELECT * FROM users WHERE id = ${req.params.id}`;',
      '  return res.json(await getUser(sql));',
      '});',
      'router.delete("/users/:id", async (req, res) => {',
      '  await deleteUser(req.params.id);',
      '  res.status(204).send();',
      '});',
      'export default router;',
    ].join('\n')),
    fixture('src/api/db.ts', [
      'export async function getUser(sql: string) { return { id: 1 }; }',
      'export async function deleteUser(id: string) { return true; }',
    ].join('\n')),
    fixture('src/auth/middleware.ts', [
      'import jwt from "jsonwebtoken";',
      'export function requireAuth(req: any, res: any, next: any) {',
      '  const token = req.headers.authorization?.split(" ")[1];',
      '  if (!token) return res.status(401).end();',
      '  const decoded = jwt.verify(token, "hardcoded-secret-key-do-not-ship");',
      '  next();',
      '}',
    ].join('\n')),
    fixture('Dockerfile', [
      'FROM node:18',
      'WORKDIR /app',
      'COPY . .',
      'RUN npm install',
      'USER root',
      'EXPOSE 3000',
      'CMD ["node", "src/app.ts"]',
    ].join('\n')),
    fixture('.dockerignore', 'node_modules\n.git\n'),
    fixture('.env.example', 'API_KEY=replace_me\nDATABASE_URL=replace_me\nJWT_SECRET=\n'),
    fixture('docker-compose.yml', 'version: "3"\nservices:\n  app:\n    image: node:18\n'),
    fixture('README.md', '# Demo\n\nA demo project.\n'),
    fixture('src/__tests__/util.test.ts', [
      'import { describe, it, expect } from "vitest";',
      'import { add } from "../lib/util.js";',
      'describe.skip("add", () => {',
      '  it.only("works", () => { expect(add(1, 2)).toBe(3); });',
      '});',
      '// FIXME: this should be unskipped',
    ].join('\n')),
    fixture('src/__tests__/handler.test.ts', [
      'import { describe, it } from "vitest";',
      'describe("handler", () => {',
      '  it("stub", () => { /* TODO write me */ });',
      '});',
    ].join('\n')),
    fixture('tsconfig.json', JSON.stringify({
      compilerOptions: {
        target: 'es2022',
        module: 'esnext',
        moduleResolution: 'node',
        strict: true,
      },
    }, null, 2)),
    fixture('.nvmrc', '18.17.0\n'),
    fixture('src/types/openapi.ts', '// generated\nexport interface User { id: string; }\n'),
    fixture('src/observability/logger.ts', [
      'export function log(msg: string) { console.error(msg); }',
    ].join('\n')),
    fixture('src/cache/store.ts', [
      'const ttl = 60000;',
      'export const cacheTtl = ttl;',
    ].join('\n')),
    fixture('src/errors/index.ts', [
      'export class AppError extends Error {}',
      'export const ERROR_CODES = { NOT_FOUND: "E001", UNAUTHORIZED: "E002" };',
    ].join('\n')),

    // --- DIRECTIVE-AUDIT FIXTURES (TS / ESLint / fitness / semgrep) ---
    fixture('src/directives/ts-suppressions.ts', [
      '// @ts-expect-error reason: testing suppression detection',
      'const x: number = "not a number" as any;',
      '// @ts-ignore — legacy shim',
      'const y: string = 42 as any;',
      '// eslint-disable-next-line no-console',
      'console.log("disabled inline");',
      '/* eslint-disable @typescript-eslint/no-explicit-any */',
      'export function takesAny(a: any) { return a; }',
      '/* eslint-enable */',
      'const stmt = 1; // eslint-disable-line no-magic-numbers',
      '// @fitness-ignore-file no-console-log -- reason',
      '// @fitness-ignore-next-line no-todo-comments -- intentional',
      '// nosemgrep: javascript.lang.security',
      'eval("nosemgrep here");',
    ].join('\n')),

    // --- DEPENDENCY-SECURITY-AUDIT (lockfile + outdated deps) ---
    fixture('package-lock.json', JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { dependencies: { lodash: '^4.0.0' } } },
    }, null, 2)),
    fixture('pnpm-lock.yaml', 'lockfileVersion: \'9.0\'\nimporters:\n  .:\n    dependencies:\n      lodash:\n        specifier: ^4.0.0\n        version: 4.17.21\n'),

    // --- PII / LOGGING SMELLS ---
    fixture('src/log/sensitive.ts', [
      'export function logUser(user: { email: string; ssn: string }) {',
      '  console.log("user email", user.email, "ssn", user.ssn);',
      '  console.error("creditCard:", "4111-1111-1111-1111");',
      '  console.warn("password=hunter2");',
      '}',
    ].join('\n')),

    // --- WEBHOOK / API-KEY ROTATION patterns ---
    fixture('src/webhooks/stripe.ts', [
      'import express from "express";',
      'export const handler = (req: express.Request) => {',
      '  // unverified webhook — should be flagged',
      '  return req.body;',
      '};',
    ].join('\n')),

    // --- OPENAPI sync target ---
    fixture('openapi.yaml', [
      'openapi: 3.0.0',
      'info:',
      '  title: Demo',
      '  version: 1.0.0',
      'paths:',
      '  /users/{id}:',
      '    get:',
      '      operationId: getUser',
      '      responses:',
      '        "200":',
      '          description: ok',
    ].join('\n')),

    // --- SENTRY / OBSERVABILITY patterns ---
    fixture('src/observability/sentry.ts', [
      'import * as Sentry from "@sentry/node";',
      'Sentry.init({ dsn: "" });',
      'export function reportError(e: Error) {',
      '  Sentry.captureException(e);',
      '}',
    ].join('\n')),
    fixture('src/observability/correlation.ts', [
      'export function makeRequestId() {',
      '  return Math.random().toString(36).slice(2);',
      '}',
    ].join('\n')),

    // --- FRONTEND smells ---
    fixture('src/ui/Form.tsx', [
      'export function Form() {',
      '  return (',
      '    <form>',
      '      <input type="text" />',
      '      <input type="email" />',
      '      <button>Submit</button>',
      '    </form>',
      '  );',
      '}',
    ].join('\n')),
    fixture('src/ui/InlineStyles.tsx', [
      'export function Box() {',
      '  return <div style={{ color: "red", margin: 8 }}>x</div>;',
      '}',
    ].join('\n')),

    // --- CIRCULAR + N+1 query patterns ---
    fixture('src/db/userRepo.ts', [
      'import { db } from "./connection.js";',
      'export async function listUsers() {',
      '  const users = await db.users.findMany();',
      '  for (const u of users) {',
      '    u.posts = await db.posts.findMany({ where: { userId: u.id } });',
      '  }',
      '  return users;',
      '}',
    ].join('\n')),
    fixture('src/db/connection.ts', 'export const db = { users: { findMany: async () => [] } as any, posts: { findMany: async () => [] } as any };'),

    // --- RECOVERY / RETRY / TIMEOUT patterns ---
    fixture('src/retry/policy.ts', [
      'export async function withRetry<T>(fn: () => Promise<T>, n = 3): Promise<T> {',
      '  let last: unknown;',
      '  for (let i = 0; i < n; i++) {',
      '    try { return await fn(); } catch (e) { last = e; }',
      '  }',
      '  throw last;',
      '}',
    ].join('\n')),

    // --- PROCESS.EXIT in finally + reentrancy ---
    fixture('src/cleanup/shutdown.ts', [
      'export function shutdown() {',
      '  try {',
      '    cleanUp();',
      '  } finally {',
      '    process.exit(0);',
      '  }',
      '}',
      'function cleanUp() { /* noop */ }',
    ].join('\n')),

    // --- LEGACY CODE markers ---
    fixture('src/legacy/old.ts', [
      '// @deprecated since v1, removed in v3',
      'export function legacyApi() { return null; }',
      '// LEGACY: kept for back-compat',
      'export const VERSION = "1";',
    ].join('\n')),

    // --- READLINE cleanup pattern ---
    fixture('src/cli/prompt.ts', [
      'import { createInterface } from "node:readline";',
      'export async function ask(q: string): Promise<string> {',
      '  const rl = createInterface({ input: process.stdin, output: process.stdout });',
      '  return new Promise(resolve => rl.question(q, ans => { rl.close(); resolve(ans); }));',
      '}',
    ].join('\n')),

    // --- BATCH + transaction patterns ---
    fixture('src/batch/processor.ts', [
      'export async function processBatch(items: number[]) {',
      '  for (const item of items) {',
      '    await new Promise(r => setTimeout(r, 10));',
      '    item;',
      '  }',
      '}',
    ].join('\n')),

    // --- MULTI-FILE no-duplicate-package fixtures ---
    fixture('packages/inner-a/package.json', JSON.stringify({ name: 'inner-a', version: '1.0.0' }, null, 2)),
    fixture('packages/inner-b/package.json', JSON.stringify({ name: 'inner-b', version: '1.0.0' }, null, 2)),
    fixture('packages/inner-a/src/index.ts', 'export const a = 1;'),
    fixture('packages/inner-b/src/index.ts', 'export const b = 2;'),

    // --- HASURA / CSP / CORS / RATE-LIMIT placeholders ---
    fixture('hasura/config.yaml', 'version: 3\nendpoint: https://example.com/v1/graphql\nadmin_secret: "should-be-env-only"\n'),
    fixture('src/security/csp.ts', [
      'export const csp = {',
      '  "default-src": "*",',
      '  "script-src": "* unsafe-inline",',
      '};',
    ].join('\n')),
    fixture('src/security/cors.ts', [
      'import express from "express";',
      'const app = express();',
      'app.use((req, res, next) => {',
      '  res.header("Access-Control-Allow-Origin", "*");',
      '  next();',
      '});',
    ].join('\n')),

    // --- TEST CONVENTION ---
    fixture('src/__tests__/skipped-suite.test.ts', [
      'import { describe, it } from "vitest";',
      'describe.skip("disabled suite", () => {',
      '  it("a", () => undefined);',
      '});',
    ].join('\n')),
    fixture('src/__tests__/focused-suite.test.ts', [
      'import { describe, it } from "vitest";',
      'describe.only("focused suite", () => {',
      '  it.only("a", () => undefined);',
      '});',
    ].join('\n')),

    // --- ENV VAR ACCESS PATTERNS ---
    fixture('src/config/env-direct.ts', [
      'export function getPort() {',
      '  // Direct, unvalidated access — should be flagged',
      '  return process.env.PORT ?? "3000";',
      '}',
      'export function badAccess() {',
      '  // No validation, no fallback, type coercion',
      '  return Number(process.env.MAX_REQUESTS);',
      '}',
    ].join('\n')),

    // --- DEPENDENCY-SECURITY-AUDIT — outdated deps ---
    fixture('package-deps.json', JSON.stringify({
      dependencies: { 'lodash': '4.0.0', 'express': '3.0.0' },
    }, null, 2)),

    // --- LOGGER-COVERAGE — unstructured + structured patterns ---
    fixture('src/services/order-service.ts', [
      'export class OrderService {',
      '  async place(order: { id: string }) {',
      '    console.log("placing order", order.id);',
      '    if (Math.random() > 0.5) console.error("order failed");',
      '    return order;',
      '  }',
      '  async cancel() {',
      '    console.warn("cancellation requested");',
      '  }',
      '}',
    ].join('\n')),

    // --- EVENT-NAME-CONSISTENCY pattern (use the same domain prefix) ---
    fixture('src/events/order-events.ts', [
      'export type OrderEvent =',
      '  | { type: "order.placed"; id: string }',
      '  | { type: "order.shipped"; id: string }',
      '  | { type: "OrderCancelled"; id: string }',
      '  | { type: "user_created"; id: string };',
    ].join('\n')),

    // --- ZOD-OPENAPI-SYNC: missing satisfies ---
    fixture('src/schemas/no-type-constraint.ts', [
      'import { z } from "zod";',
      'export const ProductSchema = z.object({',
      '  id: z.string(),',
      '  name: z.string(),',
      '  price: z.number(),',
      '});',
    ].join('\n')),

    // --- DEAD CODE / unused exports ---
    fixture('src/orphans/never-imported.ts', [
      'export function neverCalled() { return "boo"; }',
      'export const NEVER_REFERENCED = 0;',
      'export interface NeverUsed { v: number }',
    ].join('\n')),
  ];

  // Prewarm so the file cache contains every fixture for any check
  // whose scope falls back to the cache.
  await fileCache.prewarm(cwd, ['**/*']);
});

afterAll(() => {
  fileCache.clear();
  rmSync(cwd, { recursive: true, force: true });
});

describe('checks-universal — every check runs to completion', () => {
  // Use it.each for one test row per check so failures point straight
  // at the offending check.
  it.each(checks.map((c) => [c.config.slug, c]))(
    '%s runs and returns a CheckResult',
    async (_slug, check) => {
      const result = await check.run(cwd, { targetFiles: allFixturePaths });
      expect(result).toBeDefined();
      expect(result.signals).toBeDefined();
      expect(Array.isArray(result.signals)).toBe(true);
      expect(typeof result.errors).toBe('number');
      expect(typeof result.warnings).toBe('number');
      expect(result.errors).toBeGreaterThanOrEqual(0);
      expect(result.warnings).toBeGreaterThanOrEqual(0);
      expect(result.info).toBeDefined();
      expect(result.metadata).toBeDefined();
    },
    20_000,
  );
});
