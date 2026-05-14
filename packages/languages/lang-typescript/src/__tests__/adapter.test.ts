import { describe, expect, it } from 'vitest'

import { typescriptAdapter } from '../adapter.js'

describe('typescriptAdapter', () => {
  it('declares the expected identity and extensions', () => {
    expect(typescriptAdapter.id).toBe('typescript')
    expect(typescriptAdapter.fileExtensions).toContain('.ts')
    expect(typescriptAdapter.fileExtensions).toContain('.tsx')
    expect(typescriptAdapter.fileExtensions).toContain('.js')
    expect(typescriptAdapter.fileExtensions).toContain('.jsx')
  })

  it('parse() returns a non-null SourceFile for valid input', () => {
    const tree = typescriptAdapter.parse('const x = 1;', 'foo.ts')
    expect(tree).not.toBeNull()
    expect(tree?.fileName).toBe('foo.ts')
  })

  it('parse() handles broken input by returning a SourceFile (TS is forgiving)', () => {
    const tree = typescriptAdapter.parse('let x =;', 'broken.ts')
    expect(tree).not.toBeNull()
  })

  it('query.findFunctions returns named and anonymous functions', () => {
    const tree = typescriptAdapter.parse('function a(){} const b = () => {}', 'foo.ts')!
    const fns = typescriptAdapter.query!.findFunctions(tree)
    expect(fns.length).toBe(2)
    const names = fns.map((f) => f.name).sort()
    expect(names).toEqual([null, 'a'].sort())
  })

  it('query.findImports returns named imports and specifier', () => {
    const tree = typescriptAdapter.parse(
      "import { x, y } from './foo'",
      'foo.ts',
    )!
    const imports = typescriptAdapter.query!.findImports(tree)
    expect(imports.length).toBe(1)
    expect(imports[0]!.specifier).toBe('./foo')
    expect([...imports[0]!.names].sort()).toEqual(['x', 'y'])
  })

  it('query.findCallsTo matches the leaf call name', () => {
    const tree = typescriptAdapter.parse('foo(); bar.baz();', 'foo.ts')!
    expect(typescriptAdapter.query!.findCallsTo(tree, 'foo').length).toBe(1)
    expect(typescriptAdapter.query!.findCallsTo(tree, 'baz').length).toBe(1)
    expect(typescriptAdapter.query!.findCallsTo(tree, 'absent').length).toBe(0)
  })

  it('stripStrings replaces string content but preserves length', () => {
    const original = 'const x = "abc"; const y = 1'
    const stripped = typescriptAdapter.stripStrings(original)
    expect(stripped.length).toBe(original.length)
    expect(stripped).not.toContain('abc')
    expect(stripped).toContain('const x =')
    expect(stripped).toContain('const y = 1')
  })

  it('stripComments replaces comment content', () => {
    const original = '// hello\nconst x = 1'
    const stripped = typescriptAdapter.stripComments(original)
    expect(stripped.length).toBe(original.length)
    expect(stripped).not.toContain('hello')
    expect(stripped).toContain('const x = 1')
  })
})
