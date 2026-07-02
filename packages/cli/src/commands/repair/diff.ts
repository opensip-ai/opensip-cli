function splitDiffLines(content: string): readonly string[] {
  if (content === '') return [];
  const withoutTrailingNewline = content.endsWith('\n') ? content.slice(0, -1) : content;
  if (withoutTrailingNewline === '') return [''];
  return withoutTrailingNewline.split(/\r?\n/);
}

function rangeHeader(start: number, count: number): string {
  return `${start.toString()},${count.toString()}`;
}

export function unifiedDiff(relativePath: string, before: string, after: string): string {
  if (before === after) return '';

  const beforeLines = splitDiffLines(before);
  const afterLines = splitDiffLines(after);
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const beforeChunk = beforeLines.slice(prefix, beforeLines.length - suffix);
  const afterChunk = afterLines.slice(prefix, afterLines.length - suffix);
  const start = prefix + 1;
  return [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -${rangeHeader(start, beforeChunk.length)} +${rangeHeader(start, afterChunk.length)} @@`,
    ...beforeChunk.map((line) => `-${line}`),
    ...afterChunk.map((line) => `+${line}`),
  ].join('\n');
}
