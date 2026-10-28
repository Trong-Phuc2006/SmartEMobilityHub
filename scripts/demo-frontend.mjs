import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = fileURLToPath(new URL('../frontend/EMobilityHub/', import.meta.url))
const require = createRequire(new URL('../frontend/EMobilityHub/package.json', import.meta.url))
let server
async function stop() {
  await server?.close()
  if (process.connected) process.disconnect()
}
try {
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href)
  server = await createServer({ root, server: { host: 'localhost', port: Number(process.env.VITE_DEV_PORT), strictPort: true },
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify(process.env.VITE_API_BASE_URL) }, logLevel: 'info' })
  await server.listen()
  process.send?.({ ready: true })
  process.once('SIGINT', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
  process.on('message', message => { if (message === 'shutdown') void stop() })
  process.once('disconnect', () => { void server?.close() })
} catch {
  console.error('Frontend startup failed. Check installed frontend dependencies, Vite configuration and port.')
  await stop()
  process.exitCode = 1
}
