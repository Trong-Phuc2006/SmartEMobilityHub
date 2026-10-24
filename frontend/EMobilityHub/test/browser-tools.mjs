import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

export const browserPath = [process.env.BROWSER_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((filename) => filename && fs.existsSync(filename))

export async function startBrowser(t) {
  const tempBase = fs.realpathSync(os.tmpdir())
  const profile = fs.mkdtempSync(path.join(tempBase, 'semh-p4-browser-'))
  const child = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    ...(process.env.P4_BROWSER_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    '--disable-background-networking', '--disable-component-update',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  const exited = once(child, 'exit')
  let cdp
  t.after(async () => {
    if (cdp) await cdp.send('Browser.close').catch(() => {})
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
    cdp?.close()
    const resolved = path.resolve(profile)
    if (path.dirname(resolved) !== tempBase || !path.basename(resolved).startsWith('semh-p4-browser-') ||
      fs.lstatSync(resolved).isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
      throw new Error('Refusing browser profile cleanup outside owned temp')
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = ''
    const timer = setTimeout(() => reject(new Error('Headless browser did not become ready')), 15000)
    child.once('error', () => { clearTimeout(timer); reject(new Error('Browser launch failed')) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Browser exited before ready')) })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      const found = stderr.match(/DevTools listening on ws:\/\/(127\.0\.0\.1:\d+)\//)
      if (found) { clearTimeout(timer); resolve('http://' + found[1]) }
    })
  })
  const targets = await (await fetch(endpoint + '/json/list')).json()
  const target = targets.find((item) => item.type === 'page')
  if (!target) throw new Error('No browser page target')
  cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')
  return cdp
}

async function connect(url) {
  const socket = new WebSocket(url)
  await once(socket, 'open')
  let next = 0
  const pending = new Map()
  const listeners = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const task = pending.get(message.id)
      if (!task) return
      pending.delete(message.id)
      clearTimeout(task.timer)
      if (message.error) task.reject(new Error('CDP command rejected: ' + task.method))
      else task.resolve(message.result)
    } else {
      for (const listener of listeners.get(message.method) || []) listener(message.params)
    }
  })
  return {
    send(method, params = {}) {
      const id = ++next
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 12000)
        pending.set(id, { resolve, reject, timer, method })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    on(method, listener) {
      const list = listeners.get(method) || []
      list.push(listener)
      listeners.set(method, list)
    },
    close() {
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Browser closed')) }
      pending.clear()
      socket.close()
    },
  }
}

export async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error('Browser evaluation failed')
  return result.result.value
}

export async function waitFor(cdp, expression, label, timeout = 12000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await evaluate(cdp, expression)) return
    await delay(60)
  }
  throw new Error('Browser condition timed out: ' + label)
}

export async function fill(cdp, name, value) {
  await evaluate(cdp, `(() => {
    const input=document.querySelector('[name="${name}"]');
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`)
}

export const click = (cdp, selector) => evaluate(cdp, `document.querySelector(${JSON.stringify(selector)}).click()`)
export const textIncludes = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`
