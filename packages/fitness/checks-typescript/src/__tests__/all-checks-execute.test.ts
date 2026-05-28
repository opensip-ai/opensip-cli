// @fitness-ignore-file file-length-limit -- Parametric "every check executes" suite; per-check fixtures live in a single iteration block so splitting destroys the coverage contract.
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

import { RunScope, runWithScope } from '@opensip-tools/core';
import { fileCache } from '@opensip-tools/fitness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checks } from '../index.js';

const testScope = new RunScope();

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
    fixture('src/entities/address.entity.ts', [
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

    // --- React .map fixture ---
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

    // --- Awaited fetch before validation fixture ---
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

    // --- INCOMPLETE-REGEX-ESCAPING — `.replace(/[...]/, '\\$&')` shape ---
    fixture('src/regex/escape-edges.ts', [
      'export function bad1(s: string) {',
      '  // No char class — should flag',
      String.raw`  return s.replace(/abc/g, "\\$&");`,
      '}',
      'export function bad2(s: string) {',
      '  // Char class missing many specials — should flag',
      String.raw`  return s.replace(/[abc]/g, "\\$&");`,
      '}',
      'export function ok(s: string) {',
      '  // Char class includes all required specials',
      String.raw`  return s.replace(/[\\\^$.*+?()[\]{}|]/g, "\\$&");`,
      '}',
    ].join('\n')),

    // --- FASTIFY edge cases (param without access; query without access) ---
    fixture('src/routes/fastify-edges.ts', [
      'import fastify from "fastify";',
      'const app = fastify();',
      'app.get("/users/:id", async (req, res) => {',
      '  return res.send({ message: "static" });',
      '});',
      'app.get("/filter", async (req, res) => {',
      '  const filter = (req.query as { search?: string }).search ?? "";',
      '  return res.send({ filter });',
      '});',
      'app.post("/users", async (request, reply) => {',
      '  // Reads request.body but no body schema',
      '  const body = request.body as { name: string };',
      '  return reply.send({ name: body.name });',
      '});',
      'app.put("/users/:id", async (request, reply) => {',
      '  // Reads body and params; no schema',
      '  const params = request.params as { id: string };',
      '  const body = request.body as { name: string };',
      '  return reply.send({ id: params.id, name: body.name });',
      '});',
      'app.patch("/users/:id", async (request) => {',
      '  return request.body;',
      '});',
    ].join('\n')),

    // Object-literal route style (matches the alternate fastify shape)
    fixture('src/routes/fastify-object.ts', [
      'import fastify from "fastify";',
      'const app = fastify();',
      'app.route({',
      '  method: "POST",',
      '  url: "/items",',
      '  handler: async (request, reply) => {',
      '    const body = request.body as { name: string };',
      '    return reply.send({ name: body.name });',
      '  },',
      '});',
      'app.route({',
      '  method: "GET",',
      '  url: "/items/:id",',
      '  handler: async (request, reply) => {',
      '    const params = request.params as { id: string };',
      '    return reply.send({ id: params.id });',
      '  },',
      '});',
    ].join('\n')),

    // --- TYPEORM EDGE entities (some columns/decorators present, some absent) ---
    fixture('src/models/product.model.ts', [
      'import { Entity, Column, CreateDateColumn, UpdateDateColumn } from "typeorm";',
      '@Entity()',
      'export class Product {',
      '  @Column({ nullable: true }) description?: string;',
      '  @CreateDateColumn() createdAt!: Date;',
      '  @UpdateDateColumn() updatedAt!: Date;',
      '}',
      '@Entity()',
      'export class OrderRow {',
      '  @Column({ nullable: true, default: null }) notes?: string;',
      '}',
    ].join('\n')),

    // --- ERROR HANDLING — `as Error` cast in catch ---
    fixture('src/errors/cast-in-catch.ts', [
      'export async function unsafeCast() {',
      '  try {',
      '    await fetch("/api");',
      '  } catch (e) {',
      '    const err = e as Error;',
      '    console.log(err.message);',
      '  }',
      '}',
      'export async function safeCast() {',
      '  try {',
      '    JSON.parse("{}");',
      '  } catch (e) {',
      '    if (e instanceof Error) {',
      '      console.log(e.message);',
      '    }',
      '  }',
      '}',
    ].join('\n')),

    // --- LIFECYCLE cleanup with optional chaining ---
    fixture('src/lifecycle/optional-chain.ts', [
      'declare class SipDataClient { destroy?(): void; }',
      'export function setup1() {',
      '  const client = new SipDataClient();',
      '  client?.destroy?.();',
      '}',
      'export function setup2() {',
      '  const client = new SipDataClient();',
      '  return client;',
      '}',
    ].join('\n')),

    // --- SILENT-EARLY-RETURNS — nested predicate map, validator name, beyond-third-statement ---
    fixture('src/handlers/silent-edges.ts', [
      'export function fourthGuard(x: number, y: number, z: number, w: number) {',
      '  if (x === 1) return null;',
      '  if (y === 2) return null;',
      '  if (z === 3) return null;',
      '  if (w === 4) return null;',
      '  return 1;',
      '}',
      'export function inPredicateMap() {',
      '  return [1, 2, 3].map((x) => {',
      '    if (x < 0) return null;',
      '    return x * 2;',
      '  });',
      '}',
      'export function getOrNull(id: string) {',
      '  if (!id) return null;',
      '  return { id };',
      '}',
    ].join('\n')),

    // --- STREAM BUFFER size with multiple chunk array names ---
    fixture('src/streams/various-buffers.ts', [
      'export async function variantA(stream: AsyncIterable<Buffer>) {',
      '  const dataChunks: Buffer[] = [];',
      '  for await (const chunk of stream) {',
      '    dataChunks.push(chunk);',
      '  }',
      '  return Buffer.concat(dataChunks);',
      '}',
      'export function variantB(req: { on: (e: string, cb: (c: Buffer) => void) => void }) {',
      '  const buffers: Buffer[] = [];',
      '  req.on("data", (d) => { buffers.push(d); });',
      '}',
    ].join('\n')),

    // --- DISPOSE PATTERN with subscription fields not all cleaned ---
    fixture('src/lifecycle/observer.ts', [
      'export interface IDisposable { dispose(): void; }',
      'interface Sub { unsubscribe(): void; }',
      'export class Observer implements IDisposable {',
      '  private subscription1?: Sub;',
      '  private subscription2?: Sub;',
      '  private listener?: () => void;',
      '  dispose(): void {',
      '    this.subscription1?.unsubscribe();',
      '    // subscription2 + listener uncleaned',
      '  }',
      '}',
      'export class CompletelyEmpty implements IDisposable {',
      '  private sub?: Sub;',
      '  dispose(): void {}',
      '}',
    ].join('\n')),

    // --- CONTEXT SAFETY (mutation patterns) ---
    fixture('src/context/mutations.ts', [
      'export function withMutations(req: any) {',
      '  req.ctx.userId = "123";',
      '  Object.assign(req.context, { newField: "value" });',
      '  req.context.items?.push("item");',
      '  delete req.ctx.oldField;',
      '}',
      'export function safeContext(entry: any) {',
      '  entry.context.violations = [];',
      '}',
    ].join('\n')),

    // --- A11Y FORM LABELS — variants ---
    fixture('src/components/A11yForm.tsx', [
      'import React from "react";',
      'export function A11yForm() {',
      '  return (',
      '    <>',
      '      <TextInput accessibilityLabel="name" />',
      '      <Input />',
      '      <Select aria-label="country" />',
      '      <Picker accessibilityLabelledBy="label-1" />',
      '      <Input />',
      '    </>',
      '  );',
      '}',
      'function TextInput(_props: any) { return null; }',
      'function Input(_props: any) { return null; }',
      'function Select(_props: any) { return null; }',
      'function Picker(_props: any) { return null; }',
    ].join('\n')),

    // --- IN-MEMORY repository detection ---
    fixture('src/repositories/listing-repository.ts', [
      'export class ListingRepository {',
      '  private items = new Map<string, { id: string }>();',
      '  async findAll() { return [...this.items.values()]; }',
      '}',
      'export class ProfileStore {',
      '  private profiles: { id: string }[] = [];',
      '  add(p: { id: string }) { this.profiles.push(p); }',
      '}',
    ].join('\n')),

    // --- DYNAMODB scan detection ---
    fixture('src/repositories/scan-heavy-repository.ts', [
      'declare const ddb: { scan(args: unknown): Promise<unknown> };',
      'export class AuditRepository {',
      '  async listAll() {',
      '    return ddb.scan({ TableName: "audit" });',
      '  }',
      '}',
    ].join('\n')),

    // --- PLATFORM CHECKS (Platform.OS pattern) ---
    fixture('src/components/PlatformAware.tsx', [
      'import { Platform } from "react-native";',
      'export function PlatformAware() {',
      '  if (Platform.OS === "ios") return <></>;',
      '  if (Platform.OS === "android") return <></>;',
      '  return null;',
      '}',
    ].join('\n')),

    // --- TYPESCRIPT-FRONTEND tsconfig variations (jsx mode) ---
    fixture('packages/web/tsconfig.json', JSON.stringify({
      compilerOptions: {
        target: 'es5',
        module: 'commonjs',
        jsx: 'react',
        lib: ['dom', 'es2015'],
      },
    }, null, 2)),

    // --- DATABASE INDEX COVERAGE — query patterns + find ops ---
    fixture('src/repositories/user-repository.ts', [
      'declare const db: {',
      '  query(sql: string): Promise<unknown>;',
      '  users: { find(where?: unknown): Promise<unknown>; findOne(where?: unknown): Promise<unknown> };',
      '};',
      'export async function searchUnbounded() {',
      '  return db.query("SELECT * FROM users");',
      '}',
      'export async function leadingWildcard() {',
      '  return db.query("SELECT id FROM users WHERE name LIKE \'%bob%\'");',
      '}',
      'export async function findWithoutWhere() {',
      '  return db.users.find();',
      '}',
      'export async function findOneNoWhere() {',
      '  return db.users.findOne();',
      '}',
    ].join('\n')),

    // --- DATABASE SCHEMA VALIDATION (Drizzle-side detection) ---
    fixture('src/db/drizzle-edges.ts', [
      'import { pgTable, text, integer, varchar } from "drizzle-orm/pg-core";',
      'export const orders = pgTable("orders", {',
      '  customerId: integer("customer_id"),',
      '  orderNumber: integer("order_number"),',
      '  email: varchar("email", { length: 255 }),',
      '  notes: text("notes"),',
      '});',
    ].join('\n')),

    // --- PAYMENT / FINANCIAL ordering ---
    fixture('src/payments/processor.ts', [
      'declare const stripe: { charges: { create(args: { amount: number }): Promise<{ id: string }> } };',
      'declare const paypal: { pay(args: { amount: number }): Promise<void> };',
      'declare const repository: {',
      '  save(row: { id?: string; amount?: number; status?: string }): Promise<void>;',
      '  findOne(id: string): Promise<{ id: string }>;',
      '  update(id: string, patch: { status: string }): Promise<void>;',
      '};',
      'declare const processor: { refund(record: { id: string }): Promise<void> };',
      'export class PaymentService {',
      '  async processPayment(amount: number) {',
      '    const result = await stripe.charges.create({ amount });',
      '    await repository.save({ id: result.id, amount });',
      '  }',
      '  async refund(id: string) {',
      '    const record = await repository.findOne(id);',
      '    await processor.refund(record);',
      '    await repository.update(id, { status: "REFUNDED" });',
      '  }',
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
      const result = await runWithScope(testScope, () =>
        check.run(cwd, { targetFiles: allFixturePaths }),
      );
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
