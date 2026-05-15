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
