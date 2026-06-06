export function run(): void {
  try {
    doWork()
  } catch (error) {
    if (error instanceof Error) {
      report(error.message)
    }
  }
}

declare function doWork(): void
declare function report(message: string): void
