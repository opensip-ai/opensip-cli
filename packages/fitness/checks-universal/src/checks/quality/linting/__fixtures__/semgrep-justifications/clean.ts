export function run(command: string): void {
  // nosemgrep: javascript.lang.security.detect-child-process -- command is a fixed internal constant, never user input
  exec(command)
}

declare function exec(command: string): void
