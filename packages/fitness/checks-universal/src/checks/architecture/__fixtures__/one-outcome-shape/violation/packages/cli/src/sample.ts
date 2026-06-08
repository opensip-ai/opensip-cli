export function emit(cli: { emitJson: (v: unknown) => void }): void {
  cli.emitJson({ error: 'no config' })
}
