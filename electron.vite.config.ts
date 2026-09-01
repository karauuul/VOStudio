import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import type { Plugin } from 'vite'

function cspPlugin(): Plugin {
  return {
    name: 'csp-inject',
    transformIndexHtml(html) {
      const dev = process.env.NODE_ENV !== 'production'
      const script = dev ? "'self' 'unsafe-inline' blob:" : "'self' blob:"
      const connect = dev ? "'self' vostudio: blob: ws:" : "'self' vostudio: blob:"
      const meta = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src ${script}; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; media-src 'self' vostudio: blob:; connect-src ${connect}; img-src 'self' data:" />`
      return html.replace('<!--csp-->', meta)
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  renderer: {
    plugins: [react(), cspPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@': resolve(__dirname, 'src/renderer')
      }
    }
  }
})
