import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './mobile.css'

if (new URLSearchParams(location.search).get('native') === '1') {
  void import('./full/native').then(module => module.startNative())
} else createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
