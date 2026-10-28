import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { browserPath, startBrowser, evaluate, waitFor, fill, click, textIncludes } from './browser-tools.mjs'

const require = createRequire(import.meta.url)
const { startLocalDemo, seedLocalDemo, openLocalDemo, localDemoStatus } = require('../../../backend/src/config/local-demo.js')
const { localDemoFixture } = require('../../../backend/test/local-demo.helpers.js')
const { protectedSnapshot } = require('../../../backend/test/helpers.js')
const root = fileURLToPath(new URL('..', import.meta.url))
const FE = 'http://localhost:5173', BE = 'http://localhost:3000'

test('P7 file-backed browser demo, real offline/origin failures and backend restart',
  { skip: !browserPath && 'BROWSER_NOT_RUN: Chrome/Edge required', timeout: 240000 }, async (t) => {
    const before = protectedSnapshot()
    let running, vite
    t.after(async () => {
      if (running) await running.close()
      if (vite) await vite.close()
      assert.deepEqual(protectedSnapshot(), before)
    })
    const instance = localDemoFixture(t)
    const env = { PORT: '3000', HOST: 'localhost', FRONTEND_ORIGIN: FE, COOKIE_SECURE: 'false' }
    running = await startLocalDemo(instance.name, { env })
    async function startVite(apiBase = BE) {
      const server = await createServer({ root, server: { host: 'localhost', port: 5173, strictPort: true },
        define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify(apiBase) }, logLevel: 'silent' })
      await server.listen()
      return server
    }
    vite = await startVite()
    const cdp = await startBrowser(t)
    const outputRoot = process.env.SEMH_EVIDENCE_ROOT || path.join(root, '.tmp')
    fs.mkdirSync(outputRoot, { recursive: true })
    const artifacts = fs.mkdtempSync(path.join(outputRoot, 'p7-browser-'))
    const evidence = { database: 'owned file-backed SQLite', restart: {}, screenshots: [], viewports: [], authViewports: [], runtimeExceptions: 0 }
    cdp.on('Runtime.exceptionThrown', () => { evidence.runtimeExceptions++ })
    const requests = []
    cdp.on('Network.requestWillBeSent', ({ request }) => {
      if (request.url.startsWith(BE)) requests.push({ method: request.method, path: new URL(request.url).pathname })
    })
    async function screenshot(name) {
      const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
      fs.writeFileSync(path.join(artifacts, name + '.png'), Buffer.from(capture.data, 'base64'))
      evidence.screenshots.push(name + '.png')
    }
    const waitLogin = () => waitFor(cdp, "location.hash==='#/login'&&!!document.querySelector('form')", 'Login')
    const waitRows = () => waitFor(cdp, "!!document.querySelector('.em-resource-id')", 'persistent SQLite rows')
    async function reload() {
      await evaluate(cdp, 'window.__p7ReloadMarker=true')
      await cdp.send('Page.reload', { ignoreCache: true })
      await waitFor(cdp, 'window.__p7ReloadMarker!==true', 'fresh document')
    }
    async function login() {
      await fill(cdp, 'email', 'p7-browser@example.com'); await fill(cdp, 'password', 'p7-browser-fixture')
      await evaluate(cdp, "document.querySelector('form').requestSubmit()")
      await waitFor(cdp, "!!document.querySelector('[data-protected-view]')", 'authenticated view')
    }
    async function select(id) {
      await evaluate(cdp, `(() => {const s=document.querySelector('[aria-label="Chọn Mobility Hub"]');s.value=${JSON.stringify(id)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`)
    }
    await cdp.send('Page.navigate', { url: FE + '/#/register' })
    await waitFor(cdp, textIncludes('Tạo tài khoản sinh viên'), 'Register')
    await t.test('Register/Login real disk database, empty Hubs, explicit seed and public projection', async () => {
      await fill(cdp, 'email', 'p7-browser@example.com'); await fill(cdp, 'password', 'p7-browser-fixture')
      await fill(cdp, 'confirmPassword', 'p7-browser-fixture')
      await evaluate(cdp, "document.querySelector('form').requestSubmit()")
      await waitLogin(); await login()
      await waitFor(cdp, textIncludes('Chưa có Mobility Hub'), 'empty file database')
      assert.equal(localDemoStatus(instance.name).users, 1)
      await seedLocalDemo(instance.name, 'p7-browser@example.com')
      await click(cdp, '.em-state button'); await waitRows()
      assert.equal(localDemoStatus(instance.name).spaces, 6)
      assert.equal(await evaluate(cdp, textIncludes('Của bạn')), true)
      assert.equal(await evaluate(cdp, textIncludes('Người dùng khác')), true)
      assert.equal(await evaluate(cdp, textIncludes('synthetic-other@example.invalid')), false)
      assert.equal(await evaluate(cdp, "document.querySelectorAll('.em-resource-id').length"), 4)
      await screenshot('persistent-parking')
    })
    await t.test('Hub switch/search/filter/empty/Overview on persistent data', async () => {
      await fill(cdp, 'parkingSearch', '  demo-a-01 ')
      assert.equal(await evaluate(cdp, "document.querySelectorAll('.em-resource-id').length"), 1)
      await fill(cdp, 'parkingSearch', '')
      await click(cdp, '.em-filters button:nth-child(2)')
      assert.equal(await evaluate(cdp, "document.querySelectorAll('.em-resource-id').length"), 1)
      await click(cdp, '.em-filters button:nth-child(3)')
      assert.equal(await evaluate(cdp, "document.querySelectorAll('.em-resource-id').length"), 2)
      await select('demo-metro'); await waitRows()
      assert.equal(await evaluate(cdp, textIncludes('DEMO-B-01')), true)
      assert.equal(await evaluate(cdp, "document.querySelector('[name=parkingSearch]').value"), '')
      await select('demo-empty'); await waitFor(cdp, textIncludes('Hub này chưa có chỗ đỗ xe'), 'empty Hub')
      await select('demo-campus'); await waitRows()
      await click(cdp, '.em-nav-item:first-child')
      await waitFor(cdp, textIncludes('Tổng quan Mobility Hub'), 'Overview')
      await waitRows()
      await click(cdp, '.em-nav-item:nth-child(2)'); await waitRows()
    })
    await t.test('stop/restart same backend file and saved key preserves DB, JWT and existing browser cookie', async () => {
      const rows = await evaluate(cdp, "Array.from(document.querySelectorAll('.em-resource-id strong')).map(e=>e.textContent)")
      await running.close(); assert.equal(running.db.open, false)
      running = undefined
      await reload()
      await waitFor(cdp, textIncludes('Chưa thể kiểm tra phiên đăng nhập'), 'real backend offline gate')
      assert.equal(await evaluate(cdp, "!!document.querySelector('[data-protected-view]')"), false)
      const cookies = await cdp.send('Network.getCookies', { urls: [BE] })
      const hasCookie = cookies.cookies.some((c) => c.name === 'semh_auth')
      assert.equal(hasCookie, true)
      await screenshot('backend-offline-retry')
      // Reopen after the connection was closed; not an in-memory assertion.
      assert.equal(localDemoStatus(instance.name).users, 2)
      assert.equal(localDemoStatus(instance.name).spaces, 6)
      running = await startLocalDemo(instance.name, { env })
      await click(cdp, '.session-actions .button-primary'); await waitRows()
      assert.deepEqual(await evaluate(cdp, "Array.from(document.querySelectorAll('.em-resource-id strong')).map(e=>e.textContent)"), rows)
      evidence.restart = { fileReopened: true, oldBrowserCookieAccepted: true, databasePersisted: true, sameSavedSigningKey: true }
      await screenshot('restored-after-backend-restart')
    })
    await t.test('real bad frontend origin produces safe Retry without treating cookie as logged out', async () => {
      await running.close(); running = undefined
      running = await startLocalDemo(instance.name, { env: { ...env, FRONTEND_ORIGIN: 'http://localhost:5999' } })
      await reload()
      await waitFor(cdp, textIncludes('Chưa thể kiểm tra phiên đăng nhập'), 'CORS mismatch')
      assert.equal(await evaluate(cdp, "!!document.querySelector('[data-protected-view]')"), false)
      await screenshot('origin-mismatch-retry')
      await running.close(); running = await startLocalDemo(instance.name, { env })
      await click(cdp, '.session-actions .button-primary'); await waitRows()
    })
    await t.test('incorrect Vite API origin shows uncertainty; correcting it restores the same cookie', async () => {
      await vite.close(); vite = undefined
      // This valid local URL is intentionally not an API origin. Real Vite HTML
      // at /auth/me is rejected by the shared client; no fake response injected.
      vite = await startVite(FE)
      await reload()
      await waitFor(cdp, textIncludes('Chưa thể kiểm tra phiên đăng nhập'), 'wrong API base URL')
      assert.equal(await evaluate(cdp, "!!document.querySelector('[data-protected-view]')"), false)
      await screenshot('wrong-api-base-retry')
      assert.equal((await cdp.send('Network.getCookies', { urls: [BE] })).cookies.some((c) => c.name === 'semh_auth'), true)
      await vite.close(); vite = await startVite()
      await reload(); await waitRows()
    })
    await t.test('port conflicts do not replace running services and Logout network failure is uncertain', async () => {
      await assert.rejects(startLocalDemo(instance.name, { env }), { code: 'EADDRINUSE' })
      const conflict = await createServer({ root, server: { host: 'localhost', port: 5173, strictPort: true }, logLevel: 'silent' })
      try { await assert.rejects(conflict.listen(), /already in use/); } finally { await conflict.close() }
      await running.close(); running = undefined
      await click(cdp, '.account-controls > button')
      await waitFor(cdp, textIncludes('Chưa xác nhận được đăng xuất'), 'real network Logout failure')
      assert.equal(await evaluate(cdp, "!!document.querySelector('[data-protected-view]')"), false)
      running = await startLocalDemo(instance.name, { env })
      await click(cdp, '.session-actions .button-primary'); await waitLogin()
      assert.equal((await cdp.send('Network.getCookies', { urls: [BE] })).cookies.some((c) => c.name === 'semh_auth'), false)
      await login(); await waitRows()
    })
    await t.test('responsive dashboard on five viewports and current disabled-account guard', async () => {
      for (const width of [1440, 1024, 720, 390, 320]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
        const metric = await evaluate(cdp, `({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,
          internalScroll:document.querySelector('.em-table-scroll').scrollWidth>document.querySelector('.em-table-scroll').clientWidth,
          header:getComputedStyle(document.querySelector('.em-header')).height})`)
        assert.equal(metric.overflow, false)
        if (width <= 390) assert.equal(metric.internalScroll, true)
        evidence.viewports.push(metric); await screenshot('parking-' + width)
      }
      const db = openLocalDemo(instance.name)
      try { db.prepare("UPDATE Users SET status='INACTIVE' WHERE email=?").run('p7-browser@example.com'); } finally { db.close() }
      await reload(); await waitLogin()
      assert.equal(await evaluate(cdp, textIncludes('Tài khoản không hoạt động.')), true)
      assert.equal(await evaluate(cdp, "!!document.querySelector('[data-protected-view]')"), false)
      const restore = openLocalDemo(instance.name)
      try { restore.prepare("UPDATE Users SET status='ACTIVE' WHERE email=?").run('p7-browser@example.com'); } finally { restore.close() }
      await login(); await waitRows()
      await click(cdp, '.account-controls > button'); await waitLogin()
      await evaluate(cdp, "location.hash='#/overview'"); await waitLogin()
      await evaluate(cdp, 'history.back()'); await waitLogin()
      assert.equal(await evaluate(cdp, "!!document.querySelector('[data-protected-view]')"), false)
    })
    await t.test('derived Login/Register remain accessible without overflow at all five widths', async () => {
      for (const mode of ['login', 'register']) {
        await evaluate(cdp, 'location.hash=' + JSON.stringify('#/' + mode))
        await waitFor(cdp, textIncludes(mode === 'login' ? 'Chào mừng bạn đến' : 'Tạo tài khoản sinh viên'), mode + ' form')
        for (const width of [1440, 1024, 720, 390, 320]) {
          await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
          const metric = await evaluate(cdp, `({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,
            card:document.querySelector('.auth-card').getBoundingClientRect().width,
            padding:getComputedStyle(document.querySelector('.auth-card')).paddingLeft,
            input:document.querySelector('input').getBoundingClientRect().height,
            heading:getComputedStyle(document.querySelector('h1')).fontSize,
            protectedContent:!!document.querySelector('[data-protected-view]')})`)
          assert.equal(metric.overflow, false)
          assert.ok(metric.card >= 250 && metric.card <= 400, 'comfortable responsive form width')
          assert.equal(metric.padding, '0px'); assert.equal(metric.input, 48); assert.equal(metric.heading, width <= 480 ? '26px' : '28px')
          assert.equal(metric.protectedContent, false)
          evidence.authViewports.push({ mode, ...metric }); await screenshot(mode + '-' + width)
        }
      }
    })
    assert.equal(requests.some((r) => r.path === '/auth/register' && r.method === 'POST'), true)
    assert.equal(requests.some((r) => r.path.endsWith('/parking-spaces') && r.method === 'GET'), true)
    assert.equal(requests.some((r) => r.path.startsWith('/hubs') && r.method !== 'GET'), false)
    assert.equal(evidence.runtimeExceptions, 0)
    fs.writeFileSync(path.join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2))
    console.log('P7_BROWSER_EVIDENCE=' + artifacts)
  })
