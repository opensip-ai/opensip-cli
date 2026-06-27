import { execFileSync } from 'node:child_process';

export function getChanged(cwd: string): string[] {
  const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  });
  return out.trim().split('\n').filter(Boolean);
}