import * as Sentry from '@sentry/react'
import * as React from 'react'

Sentry.init({ dsn: process.env.SENTRY_DSN })

export function App(): React.ReactElement {
  return (
    <main>hello</main>
  )
}
