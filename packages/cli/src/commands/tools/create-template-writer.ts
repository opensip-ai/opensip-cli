import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import type { TemplateRenderedFile } from './create-templates.js';

function isSafeRelativePath(toolDir: string, relativePath: string): boolean {
  if (relativePath.length === 0) return false;
  const resolved = resolve(toolDir, relativePath);
  const root = resolve(toolDir);
  return resolved === root || resolved.startsWith(`${root}${sep}`);
}

export interface WriteTemplateFilesInput {
  readonly toolDir: string;
  readonly files: readonly TemplateRenderedFile[];
  readonly force?: boolean;
}

export interface WriteTemplateFilesResult {
  readonly success: boolean;
  readonly files: readonly string[];
  readonly error?: string;
}

/**
 * Write rendered template files under `toolDir`, rejecting unsafe relative paths.
 */
export function writeTemplateFiles(input: WriteTemplateFilesInput): WriteTemplateFilesResult {
  if (existsSync(input.toolDir) && !input.force) {
    return {
      success: false,
      files: [],
      error: `directory already exists: ${input.toolDir} (pass --force to overwrite scaffold files)`,
    };
  }

  for (const file of input.files) {
    if (!isSafeRelativePath(input.toolDir, file.relativePath)) {
      return {
        success: false,
        files: [],
        error: `unsafe template path rejected: ${file.relativePath}`,
      };
    }
  }

  const written: string[] = [];

  for (const file of input.files) {
    const absolutePath = join(input.toolDir, file.relativePath);
    mkdirSync(join(absolutePath, '..'), { recursive: true });
    writeFileSync(absolutePath, file.content, 'utf8');
    written.push(absolutePath);
  }

  return { success: true, files: written };
}
