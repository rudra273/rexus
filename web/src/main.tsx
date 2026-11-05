import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './auth'
import { PrefsProvider } from './prefs'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PrefsProvider>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </PrefsProvider>
  </StrictMode>,
)
