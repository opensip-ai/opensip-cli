import { describe, expect, it } from 'vitest'

import { analyzeFmtPrint } from '../checks/no-fmt-print.js'

describe('analyzeFmtPrint', () => {
  it('flags fmt.Println', () => {
    const violations = analyzeFmtPrint('fmt.Println("hi")')
    expect(violations.length).toBe(1)
    expect(violations[0]?.message).toContain('fmt.Println')
    expect(violations[0]?.line).toBe(1)
  })

  it('flags fmt.Printf', () => {
    const violations = analyzeFmtPrint('fmt.Printf("%d", n)')
    expect(violations.length).toBe(1)
    expect(violations[0]?.message).toContain('fmt.Printf')
    expect(violations[0]?.line).toBe(1)
  })

  it('flags fmt.Print', () => {
    const violations = analyzeFmtPrint('fmt.Print(x)')
    expect(violations.length).toBe(1)
    expect(violations[0]?.message).toContain('fmt.Print')
    expect(violations[0]?.line).toBe(1)
  })

  it('does not flag fmt.Sprintf (different method)', () => {
    const violations = analyzeFmtPrint('s := fmt.Sprintf("%d", n)')
    expect(violations.length).toBe(0)
  })

  it('does not flag myfmt.Println (different package)', () => {
    const violations = analyzeFmtPrint('myfmt.Println("hi")')
    expect(violations.length).toBe(0)
  })

  it('reports correct line numbers across multiple matches', () => {
    const src = `package main

func main() {
    fmt.Println("first")
    x := 1
    fmt.Printf("%d", x)
    fmt.Print("third")
}`
    const violations = analyzeFmtPrint(src)
    expect(violations.length).toBe(3)
    expect(violations[0]?.line).toBe(4)
    expect(violations[1]?.line).toBe(6)
    expect(violations[2]?.line).toBe(7)
  })
})
