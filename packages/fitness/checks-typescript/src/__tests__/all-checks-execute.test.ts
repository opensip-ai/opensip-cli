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
