export function emit(cli: { emitError: (d: unknown) => void }): void {
  cli.emitError({ message: 'no config', exitCode: 2 })
}
