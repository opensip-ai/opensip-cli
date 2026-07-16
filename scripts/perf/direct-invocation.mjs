import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export function isDirectInvocation(
  moduleUrl,
  argvEntry = process.argv[1],
  { cwd = process.cwd(), platform = process.platform } = {},
) {
  if (typeof argvEntry !== 'string' || argvEntry.length === 0) return false;

  const path = platform === 'win32' ? win32 : posix;
  const windows = platform === 'win32';
  const modulePath = path.resolve(fileURLToPath(moduleUrl, { windows }));
  const entryPath = path.resolve(cwd, argvEntry);

  return windows
    ? modulePath.toLocaleLowerCase('en-US') === entryPath.toLocaleLowerCase('en-US')
    : modulePath === entryPath;
}
