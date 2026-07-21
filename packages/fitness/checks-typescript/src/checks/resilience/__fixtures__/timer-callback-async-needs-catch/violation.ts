// Violation fixture: timer-callback promise chains with no rejection handler.
declare function doAsync(): Promise<void>;

export function startBad(): void {
  // `.finally` re-throws — it does NOT handle a rejection. `void` only silences
  // the linter. An unhandled rejection here crashes the process.
  setInterval(() => {
    void doAsync().finally(() => {
      // reset only
    });
  }, 1000);

  // Single-argument `.then` — no rejection handler.
  setTimeout(() => {
    void doAsync().then(() => undefined);
  }, 500);

  // Expression-bodied arrow returning a `.finally`-terminated chain (the timer
  // drops the returned promise → fire-and-forget with no catch).
  setImmediate(() => doAsync().finally(() => undefined));
}
