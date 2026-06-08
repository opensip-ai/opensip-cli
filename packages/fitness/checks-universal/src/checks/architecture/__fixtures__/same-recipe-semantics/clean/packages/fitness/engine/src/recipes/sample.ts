import { scheduleUnits } from '@opensip-tools/core'
export async function run(units: number[]): Promise<void> {
  await scheduleUnits({ units, mode: 'sequential', runUnit: () => Promise.resolve({ shouldStop: false }) })
}
