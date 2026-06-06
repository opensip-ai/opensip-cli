export function run(command: string): void {
  // nosemgrep: javascript.lang.security.detect-child-process
  exec(command)
}

declare function exec(command: string): void
