import { dogfoodTasks } from './dogfood.js';
import { entrypointTraceTasks } from './entrypoint-trace.js';
import { impactTasks } from './impact.js';
import { orientTasks } from './orient.js';
import { stalenessTasks } from './staleness.js';
import { testSelectionTasks } from './test-selection.js';

import type { GoldTask } from '../model/task.js';

const registeredTasks: readonly GoldTask[] = Object.freeze([
  ...orientTasks,
  ...entrypointTraceTasks,
  ...impactTasks,
  ...testSelectionTasks,
  ...stalenessTasks,
  ...dogfoodTasks,
]);

/** Closed, immutable gold-task catalog consumed by the evaluation CLI. */
export const taskRegistry: Readonly<Record<string, GoldTask>> = Object.freeze(
  Object.fromEntries(registeredTasks.map((task) => [task.id, task])),
);
