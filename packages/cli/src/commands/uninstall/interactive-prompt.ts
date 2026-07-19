/** Read one interactive line from stdin for uninstall confirmations. */
export async function interactivePrompt(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  // eslint-disable-next-line no-restricted-properties -- readline owns this interactive prompt transport; uninstall presentation still routes through the host write seam.
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
}
