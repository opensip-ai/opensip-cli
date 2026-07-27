import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { resolveInsideRoot } from './workspace-paths.js';
import { WorkspacePreparationError } from './workspace-preparation-error.js';

import type { AppliedEditRecord } from '../model/record.js';
import type { EditOperation, EditScript } from '../model/task.js';

function applyOperation(
  workspaceRoot: string,
  operation: EditOperation,
  operationIndex: number,
): AppliedEditRecord {
  const path = resolveInsideRoot(workspaceRoot, operation.path);
  try {
    switch (operation.kind) {
      case 'append': {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, operation.content, 'utf8');
        break;
      }
      case 'delete': {
        rmSync(path, { force: false });
        break;
      }
      case 'write': {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, operation.content, 'utf8');
        break;
      }
      default: {
        const exhaustive: never = operation;
        return exhaustive;
      }
    }
  } catch (error) {
    throw new WorkspacePreparationError('workspace-edit', operationIndex, error);
  }
  return { kind: operation.kind, path: operation.path };
}

/** Apply a committed, typed edit script inside a disposable fixture workspace. */
export function applyEditScript(
  workspaceRoot: string,
  script: EditScript,
): readonly AppliedEditRecord[] {
  return script.operations.map((operation, index) =>
    applyOperation(workspaceRoot, operation, index),
  );
}
