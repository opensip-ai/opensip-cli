/**
 * @fileoverview Shared directive parser types.
 *
 * The directive-audit check delegates per-grammar parsing to the
 * sibling modules in this folder. They share the `DirectiveInfo`
 * shape so the audit can sort and emit them uniformly.
 */

export type DirectiveSource = 'typescript' | 'eslint' | 'fitness' | 'semgrep'
export type DirectiveScope = 'file' | 'next-line' | 'same-line'

export interface DirectiveInfo {
  file: string
  filePath: string
  line: number
  source: DirectiveSource
  scope: DirectiveScope
  rule: string
  reason: string
  raw: string
}
