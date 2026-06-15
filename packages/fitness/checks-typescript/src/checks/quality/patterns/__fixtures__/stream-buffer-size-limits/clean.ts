const MAX_SIZE = 10 * 1024 * 1024

export async function readAll(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = []
  let totalSize = 0
  for await (const chunk of stream) {
    totalSize += chunk.length
    if (totalSize > MAX_SIZE) {
      throw new Error('Size limit exceeded')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
