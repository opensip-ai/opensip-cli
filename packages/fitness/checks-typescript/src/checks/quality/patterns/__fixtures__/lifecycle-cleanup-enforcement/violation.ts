declare const SipDataClient: new () => { destroy: () => void; ping: () => void }

export function run(): void {
  const client = new SipDataClient()
  client.ping()
}
