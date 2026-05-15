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

    // --- FASTIFY routes WITHOUT schema (fastify-schema-coverage) ---
    fixture('src/routes/fastify-unvalidated.ts', [
      'import fastify from "fastify";',
      'const app = fastify();',
      'app.post("/users", async (req, res) => {',
      '  const body = req.body as any;',
      '  return { id: body.id };',
      '});',
      'app.get("/search/:id", (req, res) => {',
      '  return res.send({ query: req.query });',
      '});',
    ].join('\n')),

    // --- ARRAY parameter validation (array-validation) ---
    fixture('src/util/unvalidated-arrays.ts', [
      'export function processItems(items: string[]): number {',
      '  // No length / type validation before access',
      '  return items.length + (items[0]?.length ?? 0);',
      '}',
      'export function findUser(ids: number[]): unknown {',
      '  return lookupUsers(ids);',
      '}',
      'async function lookupUsers(ids: number[]) { return ids.map((i) => ({ id: i })); }',
    ].join('\n')),

    // --- TYPEORM @Entity missing standard columns (database-schema-validation) ---
    fixture('src/db/incomplete-entity.ts', [
      'import { Entity, Column } from "typeorm";',
      '@Entity()',
      'export class Address {',
      '  @Column({ nullable: true }) line1!: string;',
      '  @Column() city!: string;',
      '}',
    ].join('\n')),

    // --- ZOD schema without .satisfies (zod-schema-coverage) ---
    fixture('src/schemas/no-satisfies.ts', [
      'import { z } from "zod";',
      'export const UserSchema = z.object({ id: z.string(), name: z.string() });',
      'export const CreateUserSchema = z.object({ name: z.string() });',
    ].join('\n')),

    // --- NUMERIC validation (numeric-validation) ---
    fixture('src/util/unvalidated-numbers.ts', [
      'export function scale(factor: number): number {',
      '  return factor * 2;',
      '}',
      'export function parsePort(portStr: string): number {',
      '  return Number.parseInt(portStr, 10);',
      '}',
      'export function divider(a: number, b: number): number {',
      '  return a / b; // no zero check',
      '}',
    ].join('\n')),

    // --- React .map without memo (memo-list-items) ---
    fixture('src/components/ListWithoutMemo.tsx', [
      'export function UserList({ users }: { users: { id: string; name: string }[] }) {',
      '  return (',
      '    <div>',
      '      {users.map((u) => <UserCard key={u.id} user={u} />)}',
      '    </div>',
      '  );',
      '}',
      'function UserCard({ user }: { user: { id: string; name: string } }) {',
      '  return <div>{user.name}</div>;',
      '}',
    ].join('\n')),

    // --- Silent early returns (silent-early-returns) ---
    fixture('src/handlers/silent-returns.ts', [
      'export function fetchUser(id: string) {',
      '  if (!id) return null;',
      '  if (id.length > 100) return false;',
      '  return { id };',
      '}',
      'export function findItem(items: { id: string }[], id: string) {',
      '  for (const item of items) {',
      '    if (item.id === id) return item;',
      '  }',
      '  return undefined;',
      '}',
    ].join('\n')),

    // --- Incomplete regex escaping (incomplete-regex-escaping) ---
    fixture('src/util/bad-regex-escape.ts', [
      'export function sanitize(input: string): string {',
      String.raw`  return input.replaceAll(/[abc]/g, "\\$&");`,
      '}',
      'export function escape2(input: string) {',
      '  // Missing escape for special regex chars',
      '  return input.replaceAll(new RegExp("a.b"), "x");',
      '}',
    ].join('\n')),

    // --- Stream / buffer size limits (stream-buffer-size-limits) ---
    fixture('src/streams/unbounded-buffer.ts', [
      'export async function readStream(stream: AsyncIterable<Buffer>): Promise<Buffer> {',
      '  const chunks: Buffer[] = [];',
      '  for await (const chunk of stream) {',
      '    chunks.push(chunk);',
      '  }',
      '  return Buffer.concat(chunks);',
      '}',
    ].join('\n')),

    // --- Lazy validation after expensive await (frontend/lazy-loading) ---
    fixture('src/handlers/fail-fast-violation.ts', [
      'export async function validateAndFetch(userId: string) {',
      '  const user = await fetchFromDB(userId);',
      '  if (!userId) return null;',
      '  return user;',
      '}',
      'async function fetchFromDB(id: string) { return { id }; }',
    ].join('\n')),

    // --- DEAD CODE / unused exports ---
    fixture('src/unused/unused-export.ts', [
      'export function unusedFunction() { return 42; }',
      'export const UNUSED_CONSTANT = "never used";',
      'export type UnusedType = { x: number };',
    ].join('\n')),

    // --- DISPOSE pattern completeness ---
    fixture('src/lifecycle/incomplete-dispose.ts', [
      'export interface IDisposable {',
      '  dispose(): void;',
      '}',
      'export class ResourceHolder implements IDisposable {',
      '  private subscription = { unsubscribe() { /* */ } };',
      '  private interval = setInterval(() => undefined, 1000);',
      '  // No dispose body — should flag',
      '  dispose(): void {}',
      '}',
    ].join('\n')),

    // --- LIFECYCLE cleanup enforcement (timer / subscription / event-listener) ---
    fixture('src/lifecycle/leaks.ts', [
      'export function startWatcher() {',
      '  setInterval(() => console.log("tick"), 5000);',
      '  globalThis.addEventListener("beforeunload", () => undefined);',
      '  const ws = { close() { /* */ }, on() { /* */ } };',
      '  return ws;',
      '}',
    ].join('\n')),

    // --- ERROR handling quality (catch + log without rethrow / context) ---
    fixture('src/errors/poor-handling.ts', [
      'export async function poorlyHandled() {',
      '  try {',
      '    await fetch("/api");',
      '  } catch (e) {',
      '    console.error(e);',
      '  }',
      '  try {',
      '    JSON.parse("not json");',
      '  } catch (e) {',
      '    // swallowed',
      '  }',
      '}',
    ].join('\n')),

    // --- FLASHLIST enforcement (FlatList vs FlashList) ---
    fixture('src/components/UserList.tsx', [
      'import { FlatList } from "react-native";',
      'export function UserList({ data }: { data: { id: string }[] }) {',
      '  return <FlatList data={data} renderItem={({ item }) => <></>} />;',
      '}',
    ].join('\n')),

    // --- ARRAY mutation ordering ---
    fixture('src/util/mutation-ordering.ts', [
      'export function mutate(items: number[]): number[] {',
      '  // Mutates the input then returns a sliced copy',
      '  items.sort((a, b) => a - b);',
      '  return items.slice();',
      '}',
    ].join('\n')),

    // --- ASYNC PATTERNS (forgotten await + parallel batch) ---
    fixture('src/async/missing-await.ts', [
      'export async function risky() {',
      '  // Missing await — fire and forget',
      '  fetch("/api/track");',
      '  // Sequential awaits where Promise.all would do',
      '  const a = await fetch("/api/a");',
      '  const b = await fetch("/api/b");',
      '  return [a, b];',
      '}',
    ].join('\n')),

    // --- THROWS-DOCUMENTATION (functions that throw without @throws JSDoc) ---
    fixture('src/errors/thrower.ts', [
      'export function validate(input: string) {',
      '  if (!input) throw new Error("empty input");',
      '  if (input.length > 1024) throw new RangeError("too long");',
      '  return input;',
      '}',
    ].join('\n')),

    // --- TOCTOU race condition (read-then-update on shared map) ---
    fixture('src/cache/toctou.ts', [
      'export class Counter {',
      '  private state = new Map<string, number>();',
      '  increment(key: string) {',
      '    const v = this.state.get(key) ?? 0;',
      '    this.state.set(key, v + 1);',
      '  }',
      '}',
    ].join('\n')),

    // --- STUBBED IMPLEMENTATION (NotImplemented / TODO function bodies) ---
    fixture('src/api/stubs.ts', [
      'export function notDone(): never {',
      '  throw new Error("Not implemented");',
      '}',
      'export async function todoFn() {',
      '  // TODO',
      '  return undefined;',
      '}',
    ].join('\n')),

    // --- CIRCULAR import detection (stronger pair) ---
    fixture('src/cyc/x.ts', 'import { y } from "./y.js"; export const x = () => y();'),
    fixture('src/cyc/y.ts', 'import { x } from "./x.js"; export const y = () => x();'),

    // --- DUPLICATE UTILITY FUNCTIONS ---
    fixture('src/utils/dup-a.ts', [
      'export function camelCase(s: string) { return s.replaceAll(/_([a-z])/g, (_, c: string) => c.toUpperCase()); }',
    ].join('\n')),
    fixture('src/utils/dup-b.ts', [
      'export function camelCase(input: string) {',
      '  return input.replaceAll(/_([a-z])/g, (_, c: string) => c.toUpperCase());',
      '}',
    ].join('\n')),

    // --- API CONTRACT MISMATCH (drizzle field vs DTO) ---
    fixture('src/api/dto-mismatch.ts', [
      'import { pgTable, integer, text } from "drizzle-orm/pg-core";',
      'export const products = pgTable("products", {',
      '  id: integer("id").primaryKey(),',
      '  name: text("name").notNull(),',
      '  internalCode: text("internal_code"),',
      '});',
      '// DTO is missing internalCode but the table has it',
      'export interface ProductDto { id: number; name: string }',
    ].join('\n')),

    // --- USE-CASE FUNCTIONS (silent / lazy) ---
    fixture('src/usecase/listing-fail-fast.ts', [
      'export async function createListing(input: { sellerId: string; title: string }) {',
      '  const seller = await fetch(`/api/sellers/${input.sellerId}`);',
      '  if (!input.title) return null;',
      '  return seller.json();',
      '}',
    ].join('\n')),

    // --- STREAM / network buffering ---
    fixture('src/streams/big-buffer.ts', [
      'export async function readEverything(req: { on: (e: string, cb: (c: Buffer) => void) => void }) {',
      '  return new Promise<Buffer>((resolve) => {',
      '    const chunks: Buffer[] = [];',
      '    req.on("data", (c) => { chunks.push(c); });',
      '    req.on("end", () => resolve(Buffer.concat(chunks)));',
      '  });',
      '}',
    ].join('\n')),
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
