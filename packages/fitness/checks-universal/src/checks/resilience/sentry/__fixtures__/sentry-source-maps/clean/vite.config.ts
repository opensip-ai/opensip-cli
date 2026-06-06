import { sentryVitePlugin } from '@sentry/vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [sentryVitePlugin({ org: 'acme', project: 'web' })],
})
