import * as Sentry from '@sentry/node'
import { defineConfig } from 'vite'

Sentry.init({ dsn: process.env.SENTRY_DSN })

export default defineConfig({
  plugins: [],
})
