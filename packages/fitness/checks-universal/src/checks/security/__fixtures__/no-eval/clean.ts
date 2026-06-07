export function parse(input: string): unknown {
  return JSON.parse(input)
}

// Member call `.eval(...)` is NOT JavaScript eval — ioredis / Sequelize expose
// `.eval(luaScript, …)` (a Redis server-side Lua EVAL), and identifiers that
// merely end in `eval` are unrelated. None of these should be flagged.
declare const redis: {
  eval: (script: string, numKeys: number, ...args: string[]) => Promise<unknown>
}
export async function runLua(script: string): Promise<unknown> {
  return redis.eval(script, 0)
}

function retrieval(): number {
  return 1
}
export const value = retrieval()
