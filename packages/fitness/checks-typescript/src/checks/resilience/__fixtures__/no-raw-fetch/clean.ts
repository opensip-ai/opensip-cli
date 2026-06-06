import { httpClient } from './http-client.js'

export async function load(url: string): Promise<unknown> {
  const response = await httpClient.get(url)
  return response.json()
}
