import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import { browserPath, startBrowser, evaluate, waitFor, fill, click, textIncludes } from './browser-tools.mjs'

const require = createRequire(import.meta.url)
const { startServer } = require('../../../backend/src/server.js')
const { parseConfig } = require('../../../backend/src/config/env.js')
const { protectedSnapshot } = require('../../../backend/test/helpers.js')
const { seedParking } = require('../../../backend/test/parking.helpers.js')
const jwt = require('../../../backend/node_modules/jsonwebtoken')
const root = fileURLToPath(new URL('..', import.meta.url))
const reference = path.resolve(root, '../../../Documents for Codex/Smart_E_Mobility_Hub.html')
const FE = 'http://localhost:5173', BE = 'http://localhost:3000'

test('P5 actual SQLite Parking browser flows and HTML comparison',
  { skip: !browserPath && 'BROWSER_NOT_RUN: Chrome/Edge required', timeout: 300000 }, async (t) => {
    const before = protectedSnapshot()
    const config = parseConfig({ NODE_ENV: 'test', HOST: 'localhost', PORT: '3000', FRONTEND_ORIGIN: FE,
      DATABASE_PATH: ':memory:', JWT_SECRET: randomBytes(32).toString('hex') })
    const running = await startServer({ config })
    t.after(async () => { await running.close(); assert.deepEqual(protectedSnapshot(), before) })
    const vite = await createServer({ root, server: { host: 'localhost', port: 5173, strictPort: true },
      define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify(BE) }, logLevel: 'error' })
    await vite.listen()
    t.after(() => vite.close())
    const cdp = await startBrowser(t)
    fs.mkdirSync(path.join(root, '.tmp'), { recursive: true })
    const artifacts = fs.mkdtempSync(path.join(root, '.tmp/p5-browser-'))
    const evidence = { tests: [], referenceHash: null, reference: [], react: [], screenshots: [], consoleErrors: [] }
    const requests = [], faults = new Map(), held = []
    cdp.on('Runtime.exceptionThrown', () => evidence.consoleErrors.push('browser runtime exception'))
    cdp.on('Network.requestWillBeSent', ({ request }) => {
      if (request.url.startsWith(BE)) requests.push({ path: new URL(request.url).pathname, method: request.method })
    })
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: BE + '/hubs*', requestStage: 'Request' }] })
    cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
      const action = faults.get(new URL(request.url).pathname)
      if (action === 'hold') { held.push(requestId); return }
      if (action === 'network') void cdp.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' }).catch(() => {})
      else if (action === '503' || action === '500') void cdp.send('Fetch.fulfillRequest', {
        requestId, responseCode: Number(action), responseHeaders: [
          { name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: FE },
          { name: 'Access-Control-Allow-Credentials', value: 'true' }, { name: 'Cache-Control', value: 'no-store' },
        ], body: Buffer.from(JSON.stringify({ ok: false, error: { code: action === '503' ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR', message: 'fixture', fieldErrors: {} } })).toString('base64'),
      }).catch(() => {})
      else void cdp.send('Fetch.continueRequest', { requestId }).catch(() => {})
    })
    async function release() {
      for (const requestId of held.splice(0)) await cdp.send('Fetch.continueRequest', { requestId }).catch(() => {})
    }
    async function screen(name) {
      const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
      fs.writeFileSync(path.join(artifacts, name + '.png'), Buffer.from(capture.data, 'base64'))
      evidence.screenshots.push(name + '.png')
    }
    async function viewport(width) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
    }
    async function metrics() {
      return evaluate(cdp, `(() => {
        const rect=s=>document.querySelector(s)?.getBoundingClientRect();
        const style=s=>getComputedStyle(document.querySelector(s));
        const scroll=document.querySelector('.em-table-scroll');
        return {width:innerWidth,clientWidth:document.documentElement.clientWidth,pageOverflow:document.documentElement.scrollWidth>innerWidth,
          sidebarWidth:rect('.em-sidebar').width,sidebarPadding:style('.em-sidebar').padding,
          headerHeight:rect('.em-header').height,mainPadding:style('.em-main').padding,
          cardsColumns:style('.em-cards').gridTemplateColumns,cardsGap:style('.em-cards').gap,
          cardRadius:style('.em-summary').borderRadius,cardPadding:style('.em-summary').padding,
          searchWidth:rect('.em-search')?.width,searchHeight:rect('.em-search')?.height,
          toolbarHeight:rect('.em-table-toolbar')?.height,tableWidth:rect('table')?.width,
          internalOverflow:scroll?scroll.scrollWidth>scroll.clientWidth:false,
          sticky:document.querySelector('thead')?style('thead').position:null,
          primary:style('.em').getPropertyValue('--em-blue').trim(),font:style('.em').fontFamily,
          badge:document.querySelector('.em-badge-available')?{color:style('.em-badge-available').color,background:style('.em-badge-available').backgroundColor}:null};
      })()`)
    }
    const waitLogin = () => waitFor(cdp, "location.hash==='#/login'&&!!document.querySelector('form')", 'Login')
    const waitRows = () => waitFor(cdp, "!!document.querySelector('.em tbody .em-resource-id')", 'SQLite rows')
    async function selectHub(id) {
      await evaluate(cdp, `(() => {const s=document.querySelector('[aria-label="Chọn Mobility Hub"]');s.value=${JSON.stringify(id)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`)
    }
    const rowIds = () => evaluate(cdp, "Array.from(document.querySelectorAll('.em-resource-id strong')).map(e=>e.textContent)")
    async function login() {
      await fill(cdp, 'email', 'p5-student@example.com'); await fill(cdp, 'password', 'p5-fixture-password')
      await evaluate(cdp, "document.querySelector('form').requestSubmit()")
      await waitFor(cdp, "!!document.querySelector('[data-protected-view]')", 'authenticated dashboard')
    }

    await t.test('original HTML runtime and five reference viewports', async () => {
      if (!fs.existsSync(reference)) { evidence.referenceStatus = 'NOT_VERIFIED'; return }
      evidence.referenceHash = createHash('sha256').update(fs.readFileSync(reference)).digest('hex')
      assert.equal(evidence.referenceHash, '11adb989bd6d2aed25488198a329a61a5acf57ef5f9817ad016505db69589187')
      await cdp.send('Page.navigate', { url: pathToFileURL(reference).href })
      await waitFor(cdp, "!!document.querySelector('.em-table-toolbar')", 'original HTML')
      // Dedicated Parking variant from the original local demo, no application DB.
      await evaluate(cdp, "Array.from(document.querySelectorAll('.em-nav-item')).find(b=>b.textContent==='Bãi đỗ xe').click()")
      for (const width of [1440, 1024, 720, 390, 320]) {
        await viewport(width)
        evidence.reference.push(await metrics())
        await screen('html-parking-' + width)
      }
    })

    await viewport(1440)
    await cdp.send('Page.navigate', { url: FE + '/#/register' })
    await waitFor(cdp, textIncludes('Tạo tài khoản sinh viên'), 'Register')
    await t.test('Register/Login and real empty SQLite Hub state', async () => {
      await fill(cdp, 'email', 'p5-student@example.com'); await fill(cdp, 'password', 'p5-fixture-password')
      await fill(cdp, 'confirmPassword', 'p5-fixture-password')
      await evaluate(cdp, "document.querySelector('form').requestSubmit()")
      await waitLogin(); await login()
      await waitFor(cdp, textIncludes('Chưa có Mobility Hub'), 'empty Hubs')
      assert.equal(running.db.prepare('SELECT COUNT(*) n FROM Hubs').get().n, 0)
      await screen('empty-hubs')
    })
    const userId = running.db.prepare('SELECT user_id FROM Users WHERE email=?').get('p5-student@example.com').user_id
    seedParking(running.db, userId)
    const getChanges = () => running.db.prepare('SELECT total_changes() n').get().n
    const changes = getChanges()
    await t.test('Hub loading, default sorting, SQLite table, status/ownership/privacy and capacity notice', async () => {
      faults.set('/hubs', 'hold')
      await click(cdp, '.em-state button')
      await waitFor(cdp, textIncludes('Đang tải Mobility Hub…'), 'Hub loading')
      faults.delete('/hubs'); await release(); await waitRows()
      assert.equal(await evaluate(cdp, "document.querySelector('[aria-label=" + JSON.stringify('Chọn Mobility Hub') + "]').value"), 'hub-a')
      assert.equal((await rowIds()).length, 7)
      assert.equal(await evaluate(cdp, textIncludes('Người dùng khác')), true)
      assert.equal(await evaluate(cdp, textIncludes('Chưa có thông tin')), true)
      assert.equal(await evaluate(cdp, textIncludes('Của bạn')), true)
      assert.equal(await evaluate(cdp, textIncludes('Sức chứa cấu hình: 12; số chỗ đã lưu: 7.')), true)
      assert.equal(await evaluate(cdp, textIncludes('private-other@example.com')), false)
      const states = await evaluate(cdp, "Array.from(document.querySelectorAll('.em-badge')).map(e=>e.textContent)")
      assert.equal(states.filter((s) => s === 'Còn trống').length, 1)
      assert.equal(states.filter((s) => s === 'Đã đặt').length, 3)
      assert.equal(states.filter((s) => s === 'Đang sử dụng').length, 3)
      assert.equal(await evaluate(cdp, "document.querySelectorAll('.em-actions button').length"), 0)
      assert.equal(await evaluate(cdp, "document.querySelectorAll('.em-nav-item:disabled').length"), 2)
      assert.equal(getChanges(), changes)
    })
    await t.test('All/Available/Mine/search/reset/banner preserve whole-Hub counts', async () => {
      await click(cdp, '.em-filters button:nth-child(2)')
      assert.deepEqual(await rowIds(), ['A-available'])
      await click(cdp, '.em-filters button:nth-child(3)')
      assert.equal((await rowIds()).length, 2)
      await click(cdp, '.em-filters button:first-child')
      await fill(cdp, 'parkingSearch', '  B-RESERVED  ')
      assert.deepEqual(await rowIds(), ['B-reserved-mine'])
      assert.equal(await evaluate(cdp, "document.querySelector('.em-summary-count').textContent.trim()"), '01/ 7')
      await fill(cdp, 'parkingSearch', 'no-match')
      await waitFor(cdp, textIncludes('Không tìm thấy chỗ đỗ phù hợp'), 'filtered empty')
      await click(cdp, '.em-empty button'); assert.equal((await rowIds()).length, 7)
      await click(cdp, '.em-reservation button'); assert.equal((await rowIds()).length, 2)
      await click(cdp, '.em-filters button:first-child')
    })
    await t.test('Hub switch clears old rows/search/filter; cancelled late request cannot show wrong Hub', async () => {
      await fill(cdp, 'parkingSearch', 'B-reserved')
      await click(cdp, '.em-filters button:nth-child(3)')
      faults.set('/hubs/hub-b/parking-spaces', 'hold')
      await selectHub('hub-b')
      await waitFor(cdp, textIncludes('Đang tải chỗ đỗ xe…'), 'Parking loading')
      assert.deepEqual(await rowIds(), [])
      await selectHub('hub/special ?'); await waitRows()
      assert.deepEqual(await rowIds(), ['Special-space'])
      assert.equal(await evaluate(cdp, "document.querySelector('[name=parkingSearch]').value"), '')
      assert.equal(await evaluate(cdp, "document.querySelector('.em-filters button:first-child').getAttribute('aria-pressed')"), 'true')
      faults.delete('/hubs/hub-b/parking-spaces'); await release()
      await waitFor(cdp, "document.querySelector('.em-resource-id strong')?.textContent==='Special-space'", 'late response ignored')
      await selectHub('hub-empty')
      await waitFor(cdp, textIncludes('Hub này chưa có chỗ đỗ xe'), 'empty Parking')
      assert.equal(await evaluate(cdp, "document.querySelector('.em-summary-count').textContent.trim()"), '00/ 0')
      await screen('empty-parking')
      await selectHub('hub-a'); await waitRows()
    })
    await t.test('Parking 500/503/network and Hubs503 Retry preserve authenticated session', async () => {
      for (const action of ['500', '503', 'network']) {
        faults.set('/hubs/hub-b/parking-spaces', action)
        await selectHub('hub-b')
        await waitFor(cdp, "!!document.querySelector('.em-state [role=alert]')", action + ' error')
        assert.equal(await evaluate(cdp, "!!document.querySelector('[data-protected-view]')"), true)
        faults.delete('/hubs/hub-b/parking-spaces')
        await click(cdp, '.em-state button'); await waitRows()
        assert.deepEqual(await rowIds(), ['Beta-space'])
        await selectHub('hub-a'); await waitRows()
      }
      faults.set('/hubs', '503')
      await cdp.send('Page.reload', { ignoreCache: true })
      await waitFor(cdp, "!!document.querySelector('.em-state [role=alert]')", 'Hubs503')
      faults.delete('/hubs'); await click(cdp, '.em-state button'); await waitRows()
    })
    await t.test('React five viewports: original proportions, scrolling, focus and screenshots', async () => {
      for (const width of [1440, 1024, 720, 390, 320]) {
        await viewport(width)
        const current = await metrics()
        evidence.react.push(current)
        assert.equal(current.pageOverflow, false, 'page overflow at ' + width)
        assert.equal(current.sidebarWidth, width <= 720 ? current.clientWidth : width <= 1200 ? 200 : 224)
        assert.equal(current.cardRadius, '10px')
        assert.equal(current.primary, '#2563eb')
        assert.equal(current.sticky, 'sticky')
        if (width <= 390) assert.equal(current.internalOverflow, true)
        const source = evidence.reference.find((row) => row.width === width)
        if (source) {
          for (const key of ['sidebarWidth', 'sidebarPadding', 'mainPadding', 'cardsGap', 'cardRadius', 'cardPadding', 'primary', 'font']) {
            assert.equal(current[key], source[key], key + ' at ' + width)
          }
          assert.deepEqual(current.badge, source.badge)
        }
        await evaluate(cdp, "document.querySelector('[name=parkingSearch]').focus()")
        assert.equal(await evaluate(cdp, "getComputedStyle(document.querySelector('.em-search')).outlineStyle!=='none'"), true)
        await screen('react-parking-' + width)
      }
      await viewport(1440)
      await click(cdp, '.em-nav-item:first-child')
      await waitFor(cdp, textIncludes('Tổng quan Mobility Hub'), 'Overview')
      await waitRows(); await screen('react-overview-1440')
      assert.equal(await evaluate(cdp, "document.querySelectorAll('[aria-label=" + JSON.stringify('Chọn phân hệ trong bảng') + "] option:disabled').length"), 2)
      await click(cdp, '.em-nav-item:nth-child(2)'); await waitRows()
    })
    await t.test('refresh restores session, protected GET expiry invalidates, Logout clears Parking and Back is guarded', async () => {
      await evaluate(cdp, 'window.__p5ReloadMarker=true')
      await cdp.send('Page.reload', { ignoreCache: true })
      await waitFor(cdp, "window.__p5ReloadMarker!==true && !!document.querySelector('.em tbody .em-resource-id')", 'fresh document with restored rows')
      assert.equal(await evaluate(cdp, "document.cookie.includes('semh_auth=')"), false)
      assert.equal(await evaluate(cdp, 'localStorage.length+sessionStorage.length'), 0)
      const iat = Math.floor(Date.now() / 1000) - 3601
      const token = jwt.sign({ sub: userId, iat, exp: iat + 3600, iss: 'smartemobilityhub-api', aud: 'smartemobilityhub-web' }, Buffer.from(config.jwtSecret, 'hex'), { algorithm: 'HS256' })
      await cdp.send('Network.setCookie', { name: 'semh_auth', value: token, url: BE, path: '/', httpOnly: true, sameSite: 'Lax' })
      await selectHub('hub-b'); await waitLogin()
      assert.equal(await evaluate(cdp, textIncludes('Phiên đăng nhập đã hết hạn.')), true)
      assert.equal(await evaluate(cdp, "!!document.querySelector('[data-protected-view]')"), false)
      await login(); await waitRows()
      await click(cdp, '.account-controls > button'); await waitLogin()
      await evaluate(cdp, "location.hash='#/parking'"); await waitLogin()
      await evaluate(cdp, 'history.back()'); await waitLogin()
      await evaluate(cdp, 'history.forward()'); await waitLogin()
      assert.equal(await evaluate(cdp, "!!document.querySelector('.em-resource-id')"), false)
      assert.equal(getChanges(), changes)
    })
    assert.equal(requests.some((r) => r.path === '/hubs' && r.method === 'GET'), true)
    assert.equal(requests.some((r) => r.path.endsWith('/parking-spaces') && r.method === 'GET'), true)
    assert.equal(requests.some((r) => r.path.startsWith('/hubs') && r.method !== 'GET'), false)
    assert.deepEqual(evidence.consoleErrors, [])
    evidence.tests = ['real Register/Login', 'empty/loading/Hubs', 'SQLite rows/status/ownership', 'search/filter/banner',
      'Hub switch/reset/stale', 'empty Parking', '500/503/network Retry', 'five viewports/HTML comparison', 'Overview', 'refresh/expired/Logout/Back']
    fs.writeFileSync(path.join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2))
    console.log('P5_BROWSER_EVIDENCE=' + artifacts)
  })
