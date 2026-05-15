/**
 * @fileoverview Parametric coverage for every check in checks-typescript.
 *
 * Runs each check against a curated TS-AST fixture set. The fixtures
 * include patterns each check is likely to inspect (drizzle-orm tables,
 * react components, typed-inject containers, package.json exports,
 * tsconfig variations) so per-check `analyze()` paths execute. Per-
 * check correctness assertions belong in dedicated tests; this file's
 * purpose is execution coverage.
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
   
  cwd = mkdtempSync(join(tmpdir(), 'opensip-typescript-cov-'));

  allFixturePaths = [
    fixture('package.json', JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': { import: './dist/index.js', types: './dist/index.d.ts' },
      },
      dependencies: {
        'drizzle-orm': '^0.30.0',
        'react': '^18.0.0',
        'typed-inject': '^4.0.0',
      },
      devDependencies: {
        'typescript': '^5.0.0',
        'vitest': '^2.0.0',
      },
      scripts: { build: 'tsc' },
    }, null, 2)),
    fixture('tsconfig.json', JSON.stringify({
      extends: './tsconfig.base.json',
      compilerOptions: {
        target: 'es2022',
        module: 'esnext',
        moduleResolution: 'node',
        strict: true,
        outDir: './dist',
      },
      include: ['src/**/*'],
    }, null, 2)),
    fixture('tsconfig.base.json', JSON.stringify({
      compilerOptions: {
        esModuleInterop: true,
        skipLibCheck: true,
      },
    }, null, 2)),
    fixture('src/index.ts', [
      'export { add, divide } from "./lib/util.js";',
      'export type { User } from "./types.js";',
    ].join('\n')),
    fixture('src/lib/util.ts', [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      'export async function divide(a: number, b: number): Promise<number> {',
      '  if (b === 0) throw new Error("divide by zero");',
      '  return a / b;',
      '}',
      'export function complex(',
      '  a: number, b: number, c: number, d: number, e: number, f: number',
      ') { return a + b + c + d + e + f; }',
    ].join('\n')),
    fixture('src/types.ts', [
      'export interface User { id: string; email: string; }',
      'export type UserList = readonly User[];',
    ].join('\n')),
    fixture('src/components/Button.tsx', [
      'import React, { useState, useEffect } from "react";',
      'export function Button({ label, onClick }: { label: string; onClick: () => void }) {',
      '  const [count, setCount] = useState(0);',
      '  useEffect(() => { console.log(count); }, [count]);',
      '  return <button onClick={() => { setCount(c => c + 1); onClick(); }}>{label}</button>;',
      '}',
    ].join('\n')),
    fixture('src/db/schema.ts', [
      'import { pgTable, text, integer } from "drizzle-orm/pg-core";',
      'export const users = pgTable("users", {',
      '  id: integer("id").primaryKey(),',
      '  email: text("email").notNull(),',
      '});',
    ].join('\n')),
    fixture('src/api/handler.ts', [
      'import express from "express";',
      'export async function handler(req: any) {',
      '  // SQL injection example for the security checks',
      '  const sql = `SELECT * FROM users WHERE id = ${req.params.id}`;',
      '  console.log(req.body); // PII exposure',
      '  return sql;',
      '}',
    ].join('\n')),
    fixture('src/utils/secret.ts', [
      'export function compareSecrets(a: string, b: string): boolean {',
      '  // Unsafe == comparison for secrets',
      '  return a === b;',
      '}',
    ].join('\n')),
    fixture('src/observability/metrics.ts', [
      'export function record(name: string, value: number) {',
      '  // no observability instrumentation here',
      '  return { name, value };',
      '}',
    ].join('\n')),
    fixture('src/__tests__/util.test.ts', [
      'import { describe, it, expect } from "vitest";',
      'import { add } from "../lib/util.js";',
      'describe("add", () => {',
      '  it.skip("adds", () => {',
      '    expect(add(1, 2)).toBe(3);',
      '  });',
      '});',
    ].join('\n')),
    fixture('src/circular/a.ts', 'import { b } from "./b.js"; export const a = b;'),
    fixture('src/circular/b.ts', 'import { a } from "./a.js"; export const b = a;'),

    // --- DRIZZLE ORM patterns ---
    fixture('src/db/users.ts', [
      'import { pgTable, serial, text, varchar, timestamp, integer, boolean } from "drizzle-orm/pg-core";',
      'import { relations } from "drizzle-orm";',
      'export const users = pgTable("users", {',
      '  id: serial("id").primaryKey(),',
      '  email: varchar("email", { length: 255 }).notNull().unique(),',
      '  createdAt: timestamp("created_at").defaultNow().notNull(),',
      '  isActive: boolean("is_active").default(true),',
      '  // missing index on a frequently-queried column',
      '});',
      'export const posts = pgTable("posts", {',
      '  id: serial("id").primaryKey(),',
      '  userId: integer("user_id").references(() => users.id),',
      '  title: text("title").notNull(),',
      '});',
      'export const usersRelations = relations(users, ({ many }) => ({',
      '  posts: many(posts),',
      '}));',
    ].join('\n')),
    fixture('src/db/migrations/001_create_users.ts', [
      'import { sql } from "drizzle-orm";',
      'export const up = sql`CREATE TABLE users (id SERIAL PRIMARY KEY)`;',
      'export const down = sql`DROP TABLE users`;',
    ].join('\n')),

    // --- TYPED-INJECT patterns ---
    fixture('src/di/container.ts', [
      'import { createInjector } from "typed-inject";',
      'class UserService {',
      '  static inject = ["db"] as const;',
      '  constructor(private db: any) {}',
      '}',
      'export const container = createInjector()',
      '  .provideValue("db", { query: async () => [] })',
      '  .provideClass("userService", UserService);',
    ].join('\n')),

    // --- COMPLEX EXPRESS routes (security checks) ---
    fixture('src/routes/admin.ts', [
      'import express from "express";',
      'const router = express.Router();',
      'router.get("/users", async (req, res) => {',
      '  // Missing auth guard — should flag',
      '  const all = await fetch("/api/users");',
      '  return res.json(await all.json());',
      '});',
      'router.post("/raw-html", (req, res) => {',
      '  // XSS-prone',
      '  res.send(`<div>${req.body.html}</div>`);',
      '});',
      'export default router;',
    ].join('\n')),

    // --- FORM HANDLER without label ---
    fixture('src/components/LoginForm.tsx', [
      'import React from "react";',
      'export function LoginForm() {',
      '  return (',
      '    <form>',
      '      <input type="text" />',
      '      <input type="password" />',
      '      <div onClick={() => undefined}>tap me</div>',
      '      <span style={{ cursor: "pointer" }}>also clickable</span>',
      '      <button>Submit</button>',
      '    </form>',
      '  );',
      '}',
    ].join('\n')),

    // --- N+1 candidate ---
    fixture('src/db/n-plus-one.ts', [
      'export async function listWithDetails(items: { id: number }[]) {',
      '  const out = [];',
      '  for (const item of items) {',
      '    out.push(await fetchDetail(item.id));',
      '  }',
      '  return out;',
      '}',
      'async function fetchDetail(id: number) { return { id }; }',
    ].join('\n')),

    // --- DANGEROUS REGEX ---
    fixture('src/regex/dangerous.ts', [
      'export const RE = /(a+)+b/;',
      'export const RE2 = new RegExp("(.*)*x");',
      'export function match(s: string) {',
      '  return RE.test(s);',
      '}',
    ].join('\n')),

    // --- COMPLEX CYCLOMATIC functions ---
    fixture('src/util/branch-heavy.ts', [
      'export function classify(value: number, mode: string): string {',
      '  if (mode === "a") {',
      '    if (value < 0) return "neg-a";',
      '    if (value === 0) return "zero-a";',
      '    if (value < 10) return "small-a";',
      '    if (value < 100) return "med-a";',
      '    return "big-a";',
      '  }',
      '  if (mode === "b") {',
      '    if (value < 0) return "neg-b";',
      '    if (value > 100) return "big-b";',
      '  }',
      '  if (mode === "c") return value > 50 ? "high-c" : "low-c";',
      '  return "unknown";',
      '}',
    ].join('\n')),

    // --- TYPED-INJECT misuse: missing inject decorator ---
    fixture('src/di/bad.ts', [
      'export class BadService {',
      '  // No static inject — should flag',
      '  constructor(private dep: { query(): Promise<unknown> }) {}',
      '  async run() { return this.dep.query(); }',
      '}',
    ].join('\n')),

    // --- SUSPICIOUS comparison + secret usage ---
    fixture('src/secrets/compare.ts', [
      'import { createHmac } from "node:crypto";',
      'export function checkSig(provided: string, expected: string) {',
      '  // Should use timingSafeEqual',
      '  return provided == expected;',
      '}',
      'export function badHmac(secret: string, body: string) {',
      '  const got = createHmac("sha256", secret).update(body).digest("hex");',
      '  return got === "expected-here";',
      '}',
    ].join('\n')),

    // --- API CONTRACT mismatch placeholder ---
    fixture('src/api/contract.ts', [
      'export interface UserDto {',
      '  id: string;',
      '  email: string;',
      '  createdAt: string;',
      '}',
      'export async function fetchUser(id: string): Promise<UserDto> {',
      '  return fetch(`/api/users/${id}`).then(r => r.json());',
      '}',
    ].join('\n')),

    // --- THROWS without docs ---
    fixture('src/errors/maybe-throws.ts', [
      'export function maybeThrow(arg: string) {',
      '  if (arg === "") throw new Error("empty");',
      '  if (arg.length > 100) throw new TypeError("too long");',
      '  return arg.toUpperCase();',
      '}',
    ].join('\n')),

    // --- MUTABLE STATE in module ---
    fixture('src/state/global.ts', [
      'export let counter = 0;',
      'export const state: { items: string[] } = { items: [] };',
      'export function increment() { counter++; }',
    ].join('\n')),

    // --- ASYNC PATTERNS (waterfall + missing await) ---
    fixture('src/async/waterfall.ts', [
      'export async function loadAll() {',
      '  const a = await loadA();',
      '  const b = await loadB();',
      '  const c = await loadC();',
      '  return { a, b, c };',
      '}',
      'async function loadA() { return 1; }',
      'async function loadB() { return 2; }',
      'async function loadC() { return 3; }',
    ].join('\n')),

    // --- LARGE FILE (file-size-limits) ---
    fixture('src/big/manyfns.ts', Array.from({ length: 60 }, (_, i) =>
      `export function fn${i}(x: number): number { return x + ${i}; }`,
    ).join('\n')),
  ];

  await fileCache.prewarm(cwd, ['**/*']);
});

afterAll(() => {
  fileCache.clear();
  rmSync(cwd, { recursive: true, force: true });
});

describe('checks-typescript — every check runs to completion', () => {
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
