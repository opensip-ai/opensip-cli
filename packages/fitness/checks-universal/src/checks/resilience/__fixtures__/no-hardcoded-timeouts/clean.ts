import { config } from './config.js'

export const requestTimeout = config.get('httpTimeout')
