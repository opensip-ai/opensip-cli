// Clean fixture: every timer-callback promise chain has a real rejection handler.
declare function doAsync(): Promise<void>;

export function startClean(): void {
  // `.catch` handles the rejection — safe.
  setInterval(() => {
    void doAsync().catch(() => {
      // swallow
    });
  }, 1000);

  // `.catch` before `.finally` — safe (the finally only resets state).
  setInterval(() => {
    void doAsync()
      .catch(() => undefined)
      .finally(() => undefined);
  }, 1000);

  // Two-argument `.then(onFulfilled, onRejected)` handles the rejection — safe.
  setTimeout(() => {
    void doAsync().then(
      () => undefined,
      () => undefined,
    );
  }, 500);

  // Expression-bodied arrow with a `.catch` — safe.
  setImmediate(() => doAsync().catch(() => undefined));

  // Awaited inside an async callback — safe (the await propagates to a try/catch
  // the callback owns; not a floating chain).
  setInterval(async () => {
    try {
      await doAsync();
    } catch {
      // handled
    }
  }, 1000);
}
