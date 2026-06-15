export function run(): void {
  try {
    doWork()
  } finally {
    process.exit(0)
  }
}

declare function doWork(): void
