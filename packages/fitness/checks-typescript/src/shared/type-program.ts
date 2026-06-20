/**
 * @fileoverview Shared per-run TypeScript Program accessor for type-aware checks.
 *
 * Builds ONE `ts.Program` + bound `TypeChecker` per fit run (the expensive
 * part: ~1s / ~0.6 GB on a ~900-file corpus) and reuses it across every
 * type-aware TS check, via the per-run cell the fitness tool hangs on
 * `scope.fitness.tsProgram`.
 *
 * The build logic lives HERE, not in the fitness engine, because only this
 * pack carries the `lang-typescript` / `typescript` runtime dependency — the
 * engine's cell stays a generic, opaque holder so the heavy `typescript` dep
 * never enters the engine (or non-TS check runs).
 */

import { currentScope } from '@opensip-cli/core';
import { createTypeCheckedProgram, type TypeCheckedProgram } from '@opensip-cli/lang-typescript';

/**
 * Return the run's shared type-checked Program over `rootFiles`, building it on
 * the first call and memoizing it on the fitness subscope cell so subsequent
 * type-aware checks in the same run reuse it. When no scope/subscope is active
 * (e.g. a unit test that does not enter a RunScope), builds a fresh, uncached
 * Program so the caller still works.
 */
export function getSharedTypeCheckedProgram(rootFiles: readonly string[]): TypeCheckedProgram {
  const scope = currentScope();
  const projectRoot = scope?.projectContext?.projectRoot ?? process.cwd();
  const cell = scope?.fitness?.tsProgram;
  if (!cell) {
    return createTypeCheckedProgram(rootFiles, { projectRoot });
  }
  if (cell.value === undefined) {
    cell.value = createTypeCheckedProgram(rootFiles, { projectRoot });
  }
  return cell.value as TypeCheckedProgram;
}
