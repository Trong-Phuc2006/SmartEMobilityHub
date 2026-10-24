import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, 'VITE_')
  const apiBaseUrl = env.VITE_API_BASE_URL ?? 'http://localhost:3000'
  let api
  try {
    api = new URL(apiBaseUrl)
  } catch {
    throw new Error('VITE_API_BASE_URL must be an HTTP(S) origin.')
  }
  if (!['http:', 'https:'].includes(api.protocol) || api.origin !== apiBaseUrl) {
    throw new Error('VITE_API_BASE_URL must be an exact HTTP(S) origin without credentials or a path.')
  }
  const rawPort = env.VITE_DEV_PORT ?? '5173'
  const port = Number(rawPort)
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('VITE_DEV_PORT must be an integer in 1..65535.')
  }
  return {
    root,
    plugins: [
      react(),
      babel({ presets: [reactCompilerPreset()] }),
    ],
    server: { host: 'localhost', port, strictPort: true },
    preview: { host: 'localhost', port, strictPort: true },
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify(apiBaseUrl) },
  }
})
