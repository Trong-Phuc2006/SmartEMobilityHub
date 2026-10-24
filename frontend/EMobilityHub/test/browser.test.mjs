import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { browserPath, startBrowser, evaluate, waitFor, fill, click, textIncludes } from './browser-tools.mjs'

const require = createRequire(import.meta.url)
const { startServer } = require('../../../backend/src/server.js')
const { parseConfig } = require('../../../backend/src/config/env.js')
const { protectedSnapshot } = require('../../../backend/test/helpers.js')
const jwt = require('../../../backend/node_modules/jsonwebtoken')
const root = fileURLToPath(new URL('..', import.meta.url))
const FE = 'http://localhost:5173'
const BE = 'http://localhost:3000'

test('P4 real Chrome/Express Auth integration, visual/accessibility and failure recovery',
  { skip: !browserPath && 'BROWSER_NOT_RUN: set BROWSER_PATH to Chrome/Edge', timeout: 180000 }, async (t) => {
    const before = protectedSnapshot()
    const config = parseConfig({
      NODE_ENV: 'test', HOST: 'localhost', PORT: '3000', FRONTEND_ORIGIN: FE,
      DATABASE_PATH: ':memory:', JWT_SECRET: randomBytes(32).toString('hex'),
    })
    const running = await startServer({ config })
    t.after(async () => { await running.close(); assert.deepEqual(protectedSnapshot(), before) })
    assert.equal(running.db.name, ':memory:')
    assert.equal(running.db.pragma('foreign_keys', { simple: true }), 1)
    assert.equal(running.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n, 10)
    const vite = await createServer({
      root, server: { host: 'localhost', port: 5173, strictPort: true },
      define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify(BE) },
      logLevel: 'error',
    })
    await vite.listen()
    t.after(() => vite.close())
    const cdp = await startBrowser(t)
    fs.mkdirSync(path.join(root, '.tmp'), { recursive: true })
    const artifacts = fs.mkdtempSync(path.join(root, '.tmp/p4-browser-'))
    const evidence = { tests: [], viewports: [], screenshots: [] }
    const requests = []
    const faults = new Map()
    const held = []
    cdp.on('Network.requestWillBeSent', ({ request }) => {
      if (!request.url.startsWith(BE + '/auth/')) return
      const record = { path: new URL(request.url).pathname, method: request.method }
      if (request.method === 'POST') record.fields = Object.keys(JSON.parse(request.postData || '{}')).sort()
      requests.push(record) // Never retain credentials or header/token values.
    })
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: BE + '/auth/*', requestStage: 'Request' }] })
    cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
      const action = faults.get(new URL(request.url).pathname)
      if (action === 'hold' && request.method !== 'OPTIONS') { held.push(requestId); return }
      if (action === 'network') {
        void cdp.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' }).catch(() => {})
      } else if (action === '503' || action === '500') {
        void cdp.send('Fetch.fulfillRequest', {
          requestId, responseCode: Number(action),
          responseHeaders: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Access-Control-Allow-Origin', value: FE },
            { name: 'Access-Control-Allow-Credentials', value: 'true' },
            { name: 'Cache-Control', value: 'no-store' },
          ],
          body: Buffer.from(JSON.stringify({
            ok: false, error: { code: action === '503' ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR', message: 'fixture', fieldErrors: {} },
          })).toString('base64'),
        }).catch(() => {})
      } else void cdp.send('Fetch.continueRequest', { requestId }).catch(() => {})
    })
    async function release() {
      const ids = held.splice(0)
      for (const requestId of ids) await cdp.send('Fetch.continueRequest', { requestId }).catch(() => {})
    }
    const setHash = (hash) => evaluate(cdp, 'location.hash=' + JSON.stringify(hash))
    const submit = () => evaluate(cdp, "document.querySelector('form').requestSubmit()")
    const waitLogin = () => waitFor(cdp, "location.hash==='#/login' && !!document.querySelector('form')", 'Login')
    const waitProtected = () => waitFor(cdp, "location.hash==='#/parking' && !!document.querySelector('[data-protected-view]')", 'protected Parking dashboard')
    async function login() {
      await fill(cdp, 'email', 'p4-student@example.com')
      await fill(cdp, 'password', 'p4-fixture-password')
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await waitProtected()
    }
    async function screenshot(name) {
      const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
      fs.writeFileSync(path.join(artifacts, name + '.png'), Buffer.from(result.data, 'base64'))
      evidence.screenshots.push(name + '.png')
    }
    async function viewport(width, height) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      const metrics = await evaluate(cdp, `(() => {
        const c=document.querySelector('.auth-card'),s=c&&getComputedStyle(c),input=document.querySelector('input');
        return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,
          card:c&&c.getBoundingClientRect().width,padding:s&&s.paddingLeft,
          heading:getComputedStyle(document.querySelector('h1')).fontSize,
          input:input&&input.getBoundingClientRect().height,background:getComputedStyle(document.body).backgroundColor,
          primary:getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()};
      })()`)
      evidence.viewports.push(metrics)
      assert.equal(metrics.overflow, false)
      return metrics
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await cdp.send('Page.navigate', { url: FE + '/#/register' })
    await waitFor(cdp, textIncludes('Tạo tài khoản sinh viên'), 'Register after initial Me401')

    await t.test('Register validation/loading/exact body/duplicate prevention/success', async () => {
      await submit()
      assert.equal(await evaluate(cdp, "document.querySelectorAll('[aria-invalid=true]').length"), 3)
      await fill(cdp, 'email', 'not-email')
      await fill(cdp, 'password', 'short')
      await fill(cdp, 'confirmPassword', 'different')
      await submit()
      assert.equal(await evaluate(cdp, "document.querySelectorAll('[aria-invalid=true]').length"), 3)
      assert.equal(requests.filter((r) => r.path === '/auth/register' && r.method === 'POST').length, 0)
      await fill(cdp, 'email', ' P4-Student@Example.COM ')
      await fill(cdp, 'password', 'p4-fixture-password')
      await fill(cdp, 'confirmPassword', 'p4-fixture-password')
      faults.set('/auth/register', 'hold')
      await submit()
      await waitFor(cdp, textIncludes('Đang tạo tài khoản…'), 'Register pending')
      assert.equal(await evaluate(cdp, "document.querySelector('fieldset').disabled"), true)
      await submit()
      faults.delete('/auth/register')
      await release()
      await waitLogin()
      assert.equal(await evaluate(cdp, "document.querySelector('[name=email]').value"), 'p4-student@example.com')
      assert.equal(await evaluate(cdp, textIncludes('Tạo tài khoản thành công')), true)
      const calls = requests.filter((r) => r.path === '/auth/register' && r.method === 'POST')
      assert.equal(calls.length, 1)
      assert.deepEqual(calls[0].fields, ['email', 'password'])
      assert.equal(running.db.prepare('SELECT COUNT(*) n FROM Users').get().n, 1)
    })

    await t.test('Desktop/mobile styles, password visibility, keyboard focus and screenshots', async () => {
      const desktop = await viewport(1440, 900)
      assert.equal(desktop.card, 464)
      assert.equal(desktop.padding, '26px')
      assert.equal(desktop.heading, '24px')
      assert.equal(desktop.input, 40)
      assert.equal(desktop.primary, '#2563eb')
      await screenshot('login-desktop')
      await fill(cdp, 'password', 'p4-fixture-password')
      await click(cdp, '.password-toggle')
      assert.equal(await evaluate(cdp, "document.querySelector('[name=password]').type"), 'text')
      assert.equal(await evaluate(cdp, "document.querySelector('.password-toggle').getAttribute('aria-pressed')"), 'true')
      await click(cdp, '.password-toggle')
      await fill(cdp, 'password', '')
      await evaluate(cdp, 'document.activeElement.blur()')
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      assert.equal(await evaluate(cdp, "getComputedStyle(document.activeElement).outlineWidth"), '3px')
      assert.equal(await evaluate(cdp, "Array.from(document.querySelectorAll('input')).every(i=>!!document.querySelector('label[for='+i.id+']'))"), true)
      for (const width of [390, 320]) {
        const metrics = await viewport(width, 844)
        assert.equal(metrics.card, width - 32)
      }
      await screenshot('login-mobile')
      await setHash('#/register')
      await waitFor(cdp, textIncludes('Tạo tài khoản sinh viên'), 'mobile Register')
      await viewport(390, 844)
      await screenshot('register-mobile')
      await viewport(1440, 900)
      await screenshot('register-desktop')
      await setHash('#/login')
      await waitLogin()
    })

    await t.test('EMAIL_EXISTS and invalid credentials use accessible feedback', async () => {
      await setHash('#/register')
      await waitFor(cdp, textIncludes('Tạo tài khoản sinh viên'), 'Register duplicate')
      await fill(cdp, 'email', 'p4-student@example.com')
      await fill(cdp, 'password', 'p4-fixture-password')
      await fill(cdp, 'confirmPassword', 'p4-fixture-password')
      await submit()
      await waitFor(cdp, "document.querySelector('[name=email]').getAttribute('aria-invalid')==='true' && !!document.querySelector('[role=alert]')", 'duplicate email field/alert')
      await setHash('#/login')
      await waitLogin()
      await fill(cdp, 'email', 'p4-student@example.com')
      await fill(cdp, 'password', 'incorrect-fixture')
      await submit()
      await waitFor(cdp, textIncludes('Email hoặc mật khẩu không đúng.'), 'invalid credentials')
    })

    await t.test('Login500/503/network errors remain on the form with safe retry feedback', async () => {
      for (const action of ['500', '503', 'network']) {
        faults.set('/auth/login', action)
        await fill(cdp, 'email', 'p4-student@example.com')
        await fill(cdp, 'password', 'p4-fixture-password')
        await submit()
        await waitFor(cdp, "!!document.querySelector('[role=alert]') && !document.querySelector('fieldset').disabled", 'Login transient error')
        assert.equal(await evaluate(cdp, "!!document.querySelector('[data-protected-view]')"), false)
        assert.equal(await evaluate(cdp, 'location.hash'), '#/login')
        faults.delete('/auth/login')
      }
    })

    await t.test('Login via browser cookie, public account and protected dashboards', async () => {
      await login()
      await viewport(1440, 900)
      assert.equal(await evaluate(cdp, textIncludes('Bãi đỗ xe')), true)
      assert.equal(await evaluate(cdp, textIncludes('p4-student@example.com')), true)
      assert.equal(await evaluate(cdp, "document.querySelector('.account').getAttribute('aria-label')"), 'Tài khoản: p4-student@example.com')
      const cookies = await cdp.send('Network.getCookies', { urls: [BE] })
      const auth = cookies.cookies.find((cookie) => cookie.name === 'semh_auth')
      assert.ok(auth)
      assert.equal(auth.httpOnly, true)
      assert.equal(auth.sameSite, 'Lax')
      assert.equal(auth.path, '/')
      assert.equal(auth.secure, false)
      assert.equal(await evaluate(cdp, "document.cookie.includes('semh_auth=')"), false)
      assert.equal(await evaluate(cdp, 'localStorage.length+sessionStorage.length'), 0)
      evidence.cookie = { name: auth.name, httpOnly: auth.httpOnly, sameSite: auth.sameSite, path: auth.path, secure: auth.secure }
      assert.equal(running.db.prepare('SELECT COUNT(*) n FROM Users').get().n, 1)
      await viewport(390, 844)
      assert.equal(await evaluate(cdp, "Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Đăng xuất'&&b.getBoundingClientRect().width>0)"), true)
      await screenshot('protected-mobile')
      await viewport(1440, 900)
      await screenshot('protected-desktop')
      await setHash('#/register')
      await waitProtected()
      await setHash('#/overview')
      await waitFor(cdp, textIncludes('Tổng quan Mobility Hub'), 'Overview dashboard')
      await setHash('#/unknown')
      await waitProtected()
    })

    await t.test('Refresh restores via Me with no protected flash while request is pending', async () => {
      faults.set('/auth/me', 'hold')
      await cdp.send('Page.reload', { ignoreCache: true })
      await waitFor(cdp, textIncludes('Đang kiểm tra phiên đăng nhập…'), 'restoring gate')
      assert.equal(await evaluate(cdp, "!!document.querySelector('[data-protected-view]')"), false)
      faults.delete('/auth/me')
      await release()
      await waitProtected()
    })

    await t.test('Me503/network preserve uncertainty and cookie, Retry restores session', async () => {
      for (const action of ['503', 'network']) {
        faults.set('/auth/me', action)
        await cdp.send('Page.reload', { ignoreCache: true })
        await waitFor(cdp, textIncludes('Chưa thể kiểm tra phiên đăng nhập'), 'transient session error')
        assert.equal(await evaluate(cdp, "!!document.querySelector('[data-protected-view]')"), false)
        const cookies = await cdp.send('Network.getCookies', { urls: [BE] })
        assert.equal(cookies.cookies.some((cookie) => cookie.name === 'semh_auth'), true)
        faults.delete('/auth/me')
        await click(cdp, '.session-actions .button-primary')
        await waitProtected()
      }
    })

    await t.test('failed Logout remains uncertain, retry clears browser cookie and guards Back/Forward', async () => {
      faults.set('/auth/logout', '503')
      await click(cdp, '.account-controls button')
      await waitFor(cdp, textIncludes('Chưa xác nhận được đăng xuất'), 'Logout failure')
      assert.equal(await evaluate(cdp, "!!document.querySelector('[data-protected-view]')"), false)
      faults.delete('/auth/logout')
      await click(cdp, '.session-actions .button-primary')
      await waitLogin()
      const cookies = await cdp.send('Network.getCookies', { urls: [BE] })
      assert.equal(cookies.cookies.some((cookie) => cookie.name === 'semh_auth'), false)
      await setHash('#/parking')
      await waitLogin()
      await evaluate(cdp, 'history.back()')
      await waitLogin()
      await evaluate(cdp, 'history.forward()')
      await waitLogin()
    })

    await t.test('expired/invalid sessions and disabled accounts cannot expose protected UI', async () => {
      for (const type of ['expired', 'invalid', 'disabled']) {
        await login()
        const id = running.db.prepare('SELECT user_id FROM Users WHERE email=?').get('p4-student@example.com').user_id
        if (type === 'disabled') {
          running.db.prepare('UPDATE Users SET status=? WHERE user_id=?').run('INACTIVE', id)
        } else {
          const iat = Math.floor(Date.now() / 1000) - 3601
          const token = type === 'invalid' ? 'invalid-fixture' : jwt.sign({
            sub: id, iat, exp: iat + 3600, iss: 'smartemobilityhub-api', aud: 'smartemobilityhub-web',
          }, Buffer.from(config.jwtSecret, 'hex'), { algorithm: 'HS256' })
          await cdp.send('Network.setCookie', {
            name: 'semh_auth', value: token, url: BE, path: '/', httpOnly: true, sameSite: 'Lax',
          })
        }
        await cdp.send('Page.reload', { ignoreCache: true })
        await waitLogin()
        assert.equal(await evaluate(cdp, "!!document.querySelector('[data-protected-view]')"), false)
        assert.equal(await evaluate(cdp, textIncludes(type === 'expired' ? 'Phiên đăng nhập đã hết hạn.' :
          type === 'invalid' ? 'Phiên đăng nhập không hợp lệ.' : 'Tài khoản không hoạt động.')), true)
        if (type === 'disabled') running.db.prepare('UPDATE Users SET status=? WHERE user_id=?').run('ACTIVE', id)
      }
    })

    evidence.tests = ['Register validation/body/loading/duplicate', 'Login/cookie/identity', 'Me refresh/gates/503/network retry',
      'Logout failure/retry/deletion', 'hash public/protected/unknown/Back/Forward', 'expired/invalid/disabled',
      'desktop/mobile/focus/labels/password visibility']
    fs.writeFileSync(path.join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2))
    console.log('P4_BROWSER_EVIDENCE=' + artifacts)
  })
