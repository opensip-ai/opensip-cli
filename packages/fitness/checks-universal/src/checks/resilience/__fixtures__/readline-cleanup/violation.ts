import * as readline from 'node:readline'

export function prompt(): void {
  const rl = readline.createInterface({ input: process.stdin })
  rl.question('name? ', () => undefined)
}
