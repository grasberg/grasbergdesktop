import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/theme.css'
import './styles/app.css'

// The quick-assistant window loads the same bundled entry with ?view=quick and
// mounts its own tiny surface instead of the full app (lazy, so the main
// window's entry chunk is unchanged).
const QuickApp = lazy(() => import('./components/quick/QuickApp'))

const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('Root element #root not found')
}

const isQuick = new URLSearchParams(window.location.search).get('view') === 'quick'

createRoot(rootEl).render(
  <StrictMode>
    {isQuick ? (
      <Suspense fallback={null}>
        <QuickApp />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>
)
