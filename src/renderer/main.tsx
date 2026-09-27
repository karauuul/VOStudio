import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { startRenderWorker } from './export/render-worker'
import './app.css'

if (location.hash === '#render') startRenderWorker()
else {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
