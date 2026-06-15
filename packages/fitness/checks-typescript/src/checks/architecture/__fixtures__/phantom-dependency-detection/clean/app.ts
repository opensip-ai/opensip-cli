// Clean: every external import is a declared dependency or a Node.js built-in,
// and import-like text inside a string literal must NOT be treated as an import.
import { readFileSync } from 'node:fs'
import { thing } from 'declared-pkg'

// This string contains import syntax but is not a real import — the AST-based
// extractor must ignore it (a regex extractor would wrongly flag "undeclared-x").
const sample = "import { y } from 'undeclared-x'"

export const value = readFileSync.name + thing + sample
