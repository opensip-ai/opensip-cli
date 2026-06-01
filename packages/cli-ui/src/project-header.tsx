/**
 * ProjectHeader — the single, canonical "Project: <root>" location marker.
 *
 * Rendered once per human-facing command, directly under the banner, by
 * the CLI's App shell (static commands) and by each tool's live view
 * (fit/graph). This is the ONLY renderer of the project line — RunHeader
 * no longer carries it, and the imperative pre-action print is gone — so
 * there is exactly one place the format lives.
 *
 * `--json` and `completion` never render UI, so they never reach here.
 */

import { Box } from 'ink';
import React from 'react';

import { renderToInk } from './render-to-ink.js';
import { line, type ViewNode } from './view-model.js';

export interface ProjectHeaderInput {
  /** Absolute path to the project root. */
  readonly root: string;
  /** Ancestor steps walked from cwd to root. 0 == cwd is the root. */
  readonly walkedUp?: number;
}

/**
 * The project-line text (no trailing newline — Ink owns line breaks):
 *   walkedUp 0  → `ℹ Project: <root>`
 *   walkedUp 1  → `ℹ Project: <root>  (found 1 level up)`
 *   walkedUp N  → `ℹ Project: <root>  (found N levels up)`
 */
export function formatProjectHeader(input: ProjectHeaderInput): string {
  const walkedUp = input.walkedUp ?? 0;
  const base = `ℹ Project: ${input.root}`;
  if (walkedUp === 0) return base;
  const noun = walkedUp === 1 ? 'level' : 'levels';
  return `${base}  (found ${walkedUp} ${noun} up)`;
}

/** The project line as a renderer-agnostic view-model node (rendered dim). */
export function viewProjectHeader(input: ProjectHeaderInput): ViewNode {
  return line([{ text: formatProjectHeader(input) }], true);
}

/** Ink view of {@link viewProjectHeader}. Indented to align with RunHeader. */
export function ProjectHeader({ root, walkedUp }: ProjectHeaderInput): React.ReactElement {
  return (
    <Box paddingLeft={2} paddingTop={1}>
      {renderToInk(viewProjectHeader({ root, walkedUp }))}
    </Box>
  );
}
