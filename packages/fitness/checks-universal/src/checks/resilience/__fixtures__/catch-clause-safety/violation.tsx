export function run(): void {
  try {
    doWork()
  } catch (error: any) {
    report(error.message)
  }
}

declare function doWork(): void
declare function report(message: string): void
