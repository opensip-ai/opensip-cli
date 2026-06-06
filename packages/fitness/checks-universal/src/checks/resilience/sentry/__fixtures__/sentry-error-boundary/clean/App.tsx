import * as Sentry from '@sentry/react'
import * as React from 'react'

export function App(): React.ReactElement {
  return (
    <Sentry.ErrorBoundary fallback={<p>error</p>}>
      <main>hello</main>
    </Sentry.ErrorBoundary>
  )
}
