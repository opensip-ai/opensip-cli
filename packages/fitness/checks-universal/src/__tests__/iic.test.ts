/**
 * @fileoverview Comprehensive tests for interface-implementation-consistency.
 *
 * The check parses interfaces (including multi-line `extends` clauses,
 * generic params, and inheritance chains) and classes that `implements`
 * them, then flags class methods that are absent from the interface.
 * It also has a curated allowlist of utility methods (toJSON, init, etc.)
 * and skips test-double class names (Fake*, Mock*, Stub*, Spy*).
 *
 * These fixtures drive the parser through its main code paths so the
 * parsing helpers (parseInterfaces / parseClasses / inheritance
 * resolution / generic stripping) get statement coverage.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { fileCache } from '@opensip-tools/fitness'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { checks } from '../index.js'

function findCheck(slug: string) {
  const check = checks.find((c) => c.config.slug === slug)
  if (!check) throw new Error(`check not found: ${slug}`)
  return check
}

function makeFixtureDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `cu-iic-${prefix}-`))
}

function writeFixture(cwd: string, rel: string, content: string): string {
  const abs = join(cwd, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

afterEach(() => fileCache.clear())

describe('interface-implementation-consistency', () => {
  let cwd: string
  let files: string[] = []

  beforeAll(() => {
    cwd = makeFixtureDir('basic')
    files = [
      // ----- Basic violation: extra method on class not in interface ------
      writeFixture(cwd, 'src/iface.ts', [
        'export interface IGreeter {',
        '  greet(name: string): string;',
        '}',
      ].join('\n')),
      writeFixture(cwd, 'src/impl.ts', [
        'import { IGreeter } from "./iface.js";',
        'export class Greeter implements IGreeter {',
        '  greet(name: string): string {',
        '    return "hi " + name;',
        '  }',
        '  // Extra method not declared in interface — should be flagged',
        '  shout(name: string): string {',
        '    return name.toUpperCase();',
        '  }',
        '}',
      ].join('\n')),

      // ----- Multi-line interface header with extends continuation -----
      writeFixture(cwd, 'src/multiline.ts', [
        'export interface IBase {',
        '  base(): void;',
        '}',
        'export interface IDerived',
        '  extends IBase {',
        '  derived(): void;',
        '}',
        'export class Derived implements IDerived {',
        '  base(): void {',
        '    // body',
        '  }',
        '  derived(): void {',
        '    // body',
        '  }',
        '}',
      ].join('\n')),

      // ----- Generic interfaces + generic implements -----
      writeFixture(cwd, 'src/generic.ts', [
        'export interface IRepo<T> {',
        '  find(id: string): T | undefined;',
        '  save(item: T): void;',
        '}',
        'export class UserRepo implements IRepo<{ id: string }> {',
        '  find(id: string) {',
        '    return { id };',
        '  }',
        '  save(item: { id: string }) {',
        '    void item;',
        '  }',
        '}',
      ].join('\n')),

      // ----- I-prefix lookup fallback (interface name without I prefix) -----
      writeFixture(cwd, 'src/i-prefix.ts', [
        'export interface IFoo {',
        '  doIt(): void;',
        '}',
        'export class FooImpl implements Foo {',
        '  doIt(): void {',
        '    // body',
        '  }',
        '}',
      ].join('\n')),

      // ----- Class with allowed extra methods (init, dispose, toJSON) -----
      writeFixture(cwd, 'src/allowed.ts', [
        'export interface IService {',
        '  serve(): void;',
        '}',
        'export class Service implements IService {',
        '  serve(): void {',
        '    // body',
        '  }',
        '  init(): void {',
        '    // body',
        '  }',
        '  dispose(): void {',
        '    // body',
        '  }',
        '  toJSON(): unknown {',
        '    return {};',
        '  }',
        '  start(): void {',
        '    // body',
        '  }',
        '}',
      ].join('\n')),

      // ----- Test double — skipped by name prefix -----
      writeFixture(cwd, 'src/fake.ts', [
        'export interface IClient {',
        '  send(): void;',
        '}',
        'export class FakeClient implements IClient {',
        '  send(): void {',
        '    // body',
        '  }',
        '  queueError(err: unknown): void {',
        '    void err;',
        '  }',
        '  setEvents(events: unknown[]): void {',
        '    void events;',
        '  }',
        '}',
      ].join('\n')),

      // ----- Mock prefix should also skip -----
      writeFixture(cwd, 'src/mock.ts', [
        'export interface IBus {',
        '  emit(event: string): void;',
        '}',
        'export class MockBus implements IBus {',
        '  emit(event: string): void {',
        '    void event;',
        '  }',
        '  __reset(): void {',
        '    // body',
        '  }',
        '}',
      ].join('\n')),

      // ----- Class with NO implements clause — skipped -----
      writeFixture(cwd, 'src/no-impl.ts', [
        'export class Standalone {',
        '  helper(): number { return 1; }',
        '}',
      ].join('\n')),

      // ----- Static methods on a class are not interface methods -----
      writeFixture(cwd, 'src/static.ts', [
        'export interface IFactory {',
        '  build(): void;',
        '}',
        'export class Factory implements IFactory {',
        '  build(): void {',
        '    // body',
        '  }',
        '  static create(): Factory {',
        '    return new Factory();',
        '  }',
        '}',
      ].join('\n')),

      // ----- Private/protected methods on a class are skipped -----
      writeFixture(cwd, 'src/visibility.ts', [
        'export interface IThing {',
        '  doIt(): void;',
        '}',
        'export class Thing implements IThing {',
        '  doIt(): void {',
        '    this.helper();',
        '  }',
        '  private helper(): void {',
        '    // body',
        '  }',
        '  protected hidden(): void {',
        '    // body',
        '  }',
        '}',
      ].join('\n')),

      // ----- Multiple implements clauses -----
      writeFixture(cwd, 'src/multi-impl.ts', [
        'export interface IRead {',
        '  read(): string;',
        '}',
        'export interface IWrite {',
        '  write(s: string): void;',
        '}',
        'export class IO implements IRead, IWrite {',
        '  read(): string {',
        '    return "";',
        '  }',
        '  write(s: string): void {',
        '    void s;',
        '  }',
        '  // Extra method — should fire (not in ALLOWED_EXTRA_METHODS)',
        '  drainBuffer(): void {',
        '    // no-op',
        '  }',
        '}',
      ].join('\n')),

      // ----- Extends chain in interface (transitive method inheritance) -----
      writeFixture(cwd, 'src/chain.ts', [
        'export interface IA {',
        '  a(): void;',
        '}',
        'export interface IB extends IA {',
        '  b(): void;',
        '}',
        'export interface IC extends IB {',
        '  c(): void;',
        '}',
        'export class C implements IC {',
        '  a(): void {',
        '    // implementation',
        '  }',
        '  b(): void {',
        '    // implementation',
        '  }',
        '  c(): void {',
        '    // implementation',
        '  }',
        '}',
      ].join('\n')),

      // ----- Generic type with multi-arg `extends Foo<X, Y>` -----
      writeFixture(cwd, 'src/multi-generic.ts', [
        'export interface IPair<A, B> {',
        '  first(): A;',
        '  second(): B;',
        '}',
        'export interface ITyped<T> extends IPair<T, T> {',
        '  typed(): T;',
        '}',
        'export class Typed implements ITyped<string> {',
        '  first(): string {',
        '    return "";',
        '  }',
        '  second(): string {',
        '    return "";',
        '  }',
        '  typed(): string {',
        '    return "";',
        '  }',
        '}',
      ].join('\n')),
    ]
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  it('flags an extra method on a class implementing a single interface', async () => {
    const result = await findCheck('interface-implementation-consistency').run(cwd, {
      targetFiles: files,
    })
    const matches = result.signals.map((s) => s.metadata.match)
    expect(matches.some((m) => typeof m === 'string' && m.includes('Greeter.shout'))).toBe(true)
  })

  it('flags an extra method on a class implementing multiple interfaces', async () => {
    const result = await findCheck('interface-implementation-consistency').run(cwd, {
      targetFiles: [join(cwd, 'src/multi-impl.ts')],
    })
    const matches = result.signals.map((s) => s.metadata.match)
    expect(matches).toContain('IO.drainBuffer')
  })

  it('does not flag classes whose names match Fake/Mock test-double prefixes', async () => {
    const result = await findCheck('interface-implementation-consistency').run(cwd, {
      targetFiles: files,
    })
    const matches = result.signals.map((s) => s.metadata.match)
    expect(matches.some((m) => typeof m === 'string' && m.includes('FakeClient'))).toBe(false)
    expect(matches.some((m) => typeof m === 'string' && m.includes('MockBus'))).toBe(false)
  })

  it('does not flag allowed-list utility methods (init, dispose, toJSON, start)', async () => {
    const result = await findCheck('interface-implementation-consistency').run(cwd, {
      targetFiles: files,
    })
    const matches = result.signals.map((s) => s.metadata.match)
    for (const allowed of ['Service.init', 'Service.dispose', 'Service.toJSON', 'Service.start']) {
      expect(matches.some((m) => typeof m === 'string' && m.includes(allowed))).toBe(false)
    }
  })

  it('does not flag static factory methods', async () => {
    const result = await findCheck('interface-implementation-consistency').run(cwd, {
      targetFiles: files,
    })
    const matches = result.signals.map((s) => s.metadata.match)
    expect(matches.some((m) => typeof m === 'string' && m.includes('Factory.create'))).toBe(false)
  })

  it('does not flag private/protected methods', async () => {
    const result = await findCheck('interface-implementation-consistency').run(cwd, {
      targetFiles: files,
    })
    const matches = result.signals.map((s) => s.metadata.match)
    expect(matches.some((m) => typeof m === 'string' && m.includes('Thing.helper'))).toBe(false)
    expect(matches.some((m) => typeof m === 'string' && m.includes('Thing.hidden'))).toBe(false)
  })

  it('respects transitive interface inheritance (no false positives on c())', async () => {
    const result = await findCheck('interface-implementation-consistency').run(cwd, {
      targetFiles: files,
    })
    const matches = result.signals.map((s) => s.metadata.match)
    expect(matches.some((m) => typeof m === 'string' && m.startsWith('C.'))).toBe(false)
  })

  it('does not flag classes that do not implement any interface', async () => {
    const result = await findCheck('interface-implementation-consistency').run(cwd, {
      targetFiles: files,
    })
    const matches = result.signals.map((s) => s.metadata.match)
    expect(matches.some((m) => typeof m === 'string' && m.startsWith('Standalone.'))).toBe(false)
  })
})
