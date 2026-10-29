import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { browserPath, startBrowser, evaluate, waitFor, fill, click, textIncludes } from './browser-tools.mjs'

const require = createRequire(import.meta.url)
const { localDemoFixture } = require('../../../backend/test/local-demo.helpers.js')
const { openLocalDemo } = require('../../../backend/src/config/local-demo.js')
const { protectedSnapshot, testEnv } = require('../../../backend/test/helpers.js')
const jwt = require('../../../backend/node_modules/jsonwebtoken')
const dotenv = require('../../../backend/node_modules/dotenv')
const project = fileURLToPath(new URL('../../../', import.meta.url))
const FE = 'http://localhost:5173', BE = 'http://localhost:3000'
const credentials = { email: 'vehicle-browser@example.invalid', password: 'VehicleBrowser!2026' }
const sha = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex')

test('VEH-P1 Chrome/real APIs/disk SQLite rental, races, polling, restart and five-width HTML acceptance',
  { skip: !browserPath && 'BROWSER_NOT_RUN', timeout: 360000 }, async t => {
    const before = protectedSnapshot()
    let running
    t.after(async () => { await running?.close(); assert.deepEqual(protectedSnapshot(), before) })
    const instance = localDemoFixture(t, { fresh: true })
    async function launch() {
      const env = { ...testEnv(), HOST: 'localhost', PORT: '3000', VITE_DEV_PORT: '5173', COOKIE_SECURE: 'false', DEMO_NAME: instance.name }
      delete env.FRONTEND_ORIGIN; delete env.VITE_API_BASE_URL
      const child = fork(path.join(project, 'scripts/dev-demo.js'), [], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      child.stderr.resume()
      const exited = once(child, 'exit'); let stopping
      const close = () => stopping ||= (async () => {
        if (child.exitCode !== null) return
        if (child.connected) child.send('shutdown')
        const timer = setTimeout(() => child.kill(), 12000)
        try { const [code] = await exited; assert.equal(code, 0) } finally { clearTimeout(timer) }
      })()
      running = { close }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Vehicle launcher readiness timeout')), 30000)
        child.once('message', m => { clearTimeout(timer); m.ready ? resolve() : reject(new Error('invalid readiness')) })
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Vehicle launcher exited before ready')) })
      })
    }
    await launch()
    const savedKey = sha(instance.env)
    const sql = fn => { const db = openLocalDemo(instance.name, { readonly: true }); try { return fn(db) } finally { db.close() } }
    const parkingBefore = sql(db => db.prepare("SELECT * FROM Reservations WHERE type='PARKING' ORDER BY reservation_id").all())
    const cdp = await startBrowser(t)
    const output = process.env.SEMH_EVIDENCE_ROOT || path.join(project, 'frontend/EMobilityHub/.tmp')
    fs.mkdirSync(output, { recursive: true }); const artifacts = fs.mkdtempSync(path.join(output, 'veh-browser-'))
    const evidence = { tests: [], reference: [], vehicle: [], dialogs: [], screenshots: [], exceptions: [], persistence: {}, requests: [] }
    t.after(() => { fs.writeFileSync(path.join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log('VEH_BROWSER_EVIDENCE=' + artifacts) })
    cdp.on('Runtime.exceptionThrown', () => evidence.exceptions.push('runtime exception'))
    cdp.on('Network.requestWillBeSent', ({ request }) => {
      if (request.url.startsWith(BE)) evidence.requests.push({ method: request.method, path: new URL(request.url).pathname })
    })
    const postFaults = new Map(), held = []
    let getFault = null, getMatch = null
    await cdp.send('Fetch.enable', { patterns: ['Request', 'Response'].map(requestStage => ({ urlPattern: BE + '/vehicles*', requestStage })) })
    cdp.on('Fetch.requestPaused', ({ requestId, request, responseStatusCode }) => {
      const url = new URL(request.url), post = request.method === 'POST', fault = post ? postFaults.get(url.pathname) : (!getMatch || request.url.includes(getMatch)) ? getFault : null
      const send = (method, args) => { void cdp.send(method, { requestId, ...args }).catch(() => {}) }
      if (responseStatusCode !== undefined) {
        if (post && fault === 'lost') send('Fetch.failRequest', { errorReason: 'ConnectionFailed' })
        else if (!post && fault === 'hold-response') held.push(requestId)
        else send('Fetch.continueRequest', {})
        return
      }
      if (fault === 'hold') { held.push(requestId); return }
      if (fault === 'network') send('Fetch.failRequest', { errorReason: 'ConnectionFailed' })
      else if (fault === '500' || fault === '503') send('Fetch.fulfillRequest', { responseCode: Number(fault), responseHeaders: [
        { name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: FE }, { name: 'Access-Control-Allow-Credentials', value: 'true' },
      ], body: Buffer.from(JSON.stringify({ ok: false, error: { code: fault === '503' ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR', fieldErrors: {} } })).toString('base64') })
      else send('Fetch.continueRequest', {})
    })
    async function release() { for (const requestId of held.splice(0)) await cdp.send('Fetch.continueRequest', { requestId }).catch(() => {}) }
    const viewport = width => cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
    async function screen(name) { const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); fs.writeFileSync(path.join(artifacts, name + '.png'), Buffer.from(data, 'base64')); evidence.screenshots.push(name + '.png') }
    const waitLogin = () => waitFor(cdp, "location.hash==='#/login' && !!document.querySelector('form')", 'Vehicle Login')
    const waitVehicle = () => waitFor(cdp, "!!document.querySelector('.em-vehicle-table')", 'Vehicle table')
    const row = id => `document.querySelector('[data-vehicle-id="${id}"]')`
    const countPosts = () => evidence.requests.filter(r => r.method === 'POST' && r.path.startsWith('/vehicles/')).length
    const dialogClosed = () => waitFor(cdp, "!document.querySelector('dialog[open]')", 'Vehicle dialog closed')
    async function action(id, operation, banner = false) {
      await waitFor(cdp, banner ? `!!document.querySelector('[data-own-rentals] [data-vehicle-action="${operation}"]:not(:disabled)')`
        : `!!(${row(id)})?.querySelector('[data-vehicle-action="${operation}"]:not(:disabled)')`, 'enabled Vehicle action ' + operation)
      await evaluate(cdp, banner ? `document.querySelector('[data-own-rentals] [data-vehicle-action="${operation}"]').click()` : `(${row(id)}).querySelector('[data-vehicle-action="${operation}"]').click()`)
      await waitFor(cdp, "!!document.querySelector('dialog[open]')", 'Vehicle confirmation')
    }
    async function confirm() { await click(cdp, '[data-confirm-vehicle]') }
    async function reload() {
      const old = await evaluate(cdp, 'performance.timeOrigin'); await cdp.send('Page.reload', { ignoreCache: true })
      await waitFor(cdp, `performance.timeOrigin!==${old}`, 'new Vehicle document'); await waitVehicle()
    }
    async function nav(selector) { await click(cdp, selector); await waitVehicle() }
    async function selectHub(id) {
      await evaluate(cdp, `(()=>{const s=document.querySelector('[aria-label="Chọn Mobility Hub"]');s.value=${JSON.stringify(id)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`)
      await waitVehicle(); await waitFor(cdp, `document.querySelector('[aria-label="Chọn Mobility Hub"]').value===${JSON.stringify(id)}`, 'selected Hub')
    }
    async function global() { await click(cdp, '[aria-label="Phạm vi phương tiện"] button:nth-child(2)'); await waitVehicle() }
    async function request(route, body, cookie) {
      const response = await fetch(BE + route, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: FE, Connection: 'close', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
    }
    const browserRequest = (route, body) => evaluate(cdp, `fetch(${JSON.stringify(BE + route)},{credentials:'include',method:${JSON.stringify(body === undefined ? 'GET' : 'POST')},${body === undefined ? '' : `headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))},`}}).then(async r=>({status:r.status,body:await r.json()}))`)
    async function metrics() {
      return evaluate(cdp, `(()=>{const r=s=>document.querySelector(s)?.getBoundingClientRect(),c=s=>getComputedStyle(document.querySelector(s));return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,sidebar:r('.em-sidebar').width,header:r('.em-header').height,cards:c('.em-cards').gridTemplateColumns,gap:c('.em-cards').gap,radius:c('.em-summary').borderRadius,font:c('.em').fontFamily,primary:c('.em').getPropertyValue('--em-blue').trim(),sticky:c('thead').position,table:r('table').width,columns:Array.from(document.querySelectorAll('thead th')).map(x=>x.getBoundingClientRect().width),internalScroll:document.querySelector('.em-table-scroll').scrollWidth>document.querySelector('.em-table-scroll').clientWidth,battery:r('.em-battery-track')?.width}})()`)
    }

    await t.test('original HTML Vehicle layout is inspected at five reference widths', async () => {
      await cdp.send('Page.navigate', { url: pathToFileURL(path.resolve(project, '../Smart_E_Mobility_Hub.html')).href })
      await waitFor(cdp, "document.querySelectorAll('.em-nav-item').length===4", 'original HTML')
      await click(cdp, '.em-nav-item:nth-child(3)')
      for (const width of [1440, 1024, 720, 390, 320]) { await viewport(width); await delay(80); const m = await metrics(); assert.equal(m.columns.length, 6); evidence.reference.push(m); await screen('html-vehicle-' + width) }
      await viewport(1440)
    })
    await t.test('protected Vehicle navigation, real Register/Login, Hub summary, six columns, battery and search', async () => {
      await cdp.send('Page.navigate', { url: FE + '/#/vehicle' }); await waitLogin()
      await click(cdp, '.auth-footer a'); await waitFor(cdp, "location.hash==='#/register'", 'Register')
      await fill(cdp, 'email', credentials.email); await fill(cdp, 'password', credentials.password); await fill(cdp, 'confirmPassword', credentials.password)
      await evaluate(cdp, "document.querySelector('form').requestSubmit()"); await waitLogin()
      await fill(cdp, 'password', credentials.password); await evaluate(cdp, "document.querySelector('form').requestSubmit()")
      await waitFor(cdp, "!!document.querySelector('.em-nav-item')", 'authenticated Parking')
      await nav('.em-nav-item:nth-child(3)')
      assert.equal(await evaluate(cdp, "document.querySelectorAll('thead th').length"), 6)
      assert.equal(await evaluate(cdp, `(${row('CAMPUS-V19')}).querySelector('button').disabled`), true)
      assert.equal(await evaluate(cdp, `(${row('CAMPUS-V20')}).querySelector('button').disabled`), false)
      assert.equal(await evaluate(cdp, "document.querySelector('.em-summary:nth-child(2) .em-summary-count').innerText.replaceAll(' ','').replaceAll(String.fromCharCode(10),'')"), '04/5')
      await fill(cdp, 'vehicleSearch', '  MÁY ĐIỆN  '); assert.equal(await evaluate(cdp, "document.querySelectorAll('tbody [data-vehicle-id]').length"), 2)
      await fill(cdp, 'vehicleSearch', 'missing'); assert.equal(await evaluate(cdp, textIncludes('Không tìm thấy phương tiện phù hợp')), true)
      await fill(cdp, 'vehicleSearch', '')
      assert.equal((await browserRequest('/vehicles/CAMPUS-V19/reserve', {})).body.error.code, 'BATTERY_TOO_LOW')
      assert.equal(sql(db => db.prepare('SELECT COUNT(*) n FROM Users').get().n), 4)
    })
    await t.test('reserve pin20 pending/double-click, Escape/backdrop/focus, refresh persistence', async () => {
      await action('CAMPUS-V20', 'reserve')
      assert.equal(await evaluate(cdp, "document.activeElement.classList.contains('em-btn-cancel')"), true)
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await dialogClosed()
      assert.equal(await evaluate(cdp, "document.activeElement.dataset.vehicleAction"), 'reserve')
      await action('CAMPUS-V20', 'reserve'); await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 2, y: 2, button: 'left', clickCount: 1 }); await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 2, button: 'left', clickCount: 1 }); await dialogClosed()
      postFaults.set('/vehicles/CAMPUS-V20/reserve', 'hold'); await action('CAMPUS-V20', 'reserve'); const count = countPosts()
      await evaluate(cdp, "document.querySelector('[data-confirm-vehicle]').click();document.querySelector('[data-confirm-vehicle]').click()")
      await waitFor(cdp, "document.querySelector('[data-confirm-vehicle]').disabled", 'Vehicle pending')
      await delay(150); assert.equal(countPosts(), count + 1)
      await evaluate(cdp, "location.hash='#/parking'")
      await waitFor(cdp, "location.hash==='#/vehicle' && !!document.querySelector('dialog[open]')", 'pending route preserves recovery context')
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      assert.equal(await evaluate(cdp, "!!document.querySelector('dialog[open]')"), true)
      postFaults.clear(); await release(); await dialogClosed(); await waitFor(cdp, textIncludes('Đã đặt xe'), 'reserve confirmed')
      assert.equal(sql(db => db.prepare("SELECT state FROM Vehicles WHERE vehicle_id='CAMPUS-V20'").get().state), 'RESERVED')
      await reload(); await waitFor(cdp, "!!document.querySelector('[data-own-rentals]')", 'restored rental')
      await screen('reserved-own-rental')
    })
    await t.test('pickup keeps NULL-Hub rental accessible through navigation/reload and same-file/key restart; cross-Hub return', async () => {
      await action('CAMPUS-V20', 'pickup', true); await confirm(); await dialogClosed()
      await waitFor(cdp, "!!document.querySelector('[data-own-rentals] [data-vehicle-action=return]')", 'owned IN_USE')
      assert.equal(await evaluate(cdp, `!!(${row('CAMPUS-V20')})`), false)
      assert.equal(sql(db => db.prepare("SELECT hub_id FROM Vehicles WHERE vehicle_id='CAMPUS-V20'").get().hub_id), null)
      assert.equal((await browserRequest('/vehicles/CAMPUS-V20/cancel', {})).body.error.code, 'INVALID_VEHICLE_TRANSITION')
      await reload(); await waitFor(cdp, "!!document.querySelector('[data-vehicle-action=return]')", 'Return survives refresh')
      await click(cdp, '.em-nav-item:nth-child(2)'); await waitFor(cdp, "!!document.querySelector('[data-action=reserve]')", 'Parking retained')
      await nav('.em-nav-item:nth-child(3)'); await waitFor(cdp, "!!document.querySelector('[data-own-rentals] [data-vehicle-action=return]')", 'Return survives navigation')
      await running.close(); await click(cdp, '.em-vehicle-controls > button'); await waitFor(cdp, textIncludes('Chưa thể cập nhật danh sách'), 'backend offline')
      assert.equal(await evaluate(cdp, "!!document.querySelector('[data-own-rentals] [data-vehicle-action=return]')"), true)
      await launch(); assert.equal(sha(instance.env), savedKey); await click(cdp, '.em-vehicle-controls > button')
      await waitFor(cdp, "!document.querySelector('.em-vehicle-page [role=alert]')", 'restart reconciliation')
      assert.equal((await browserRequest('/auth/me')).status, 200)
      await action('CAMPUS-V20', 'return', true); await confirm(); assert.equal(await evaluate(cdp, textIncludes('Chọn Hub trả xe và nhập mức pin')), true)
      await evaluate(cdp, "(()=>{const s=document.querySelector('[name=returnHub]');s.value='metro';s.dispatchEvent(new Event('change',{bubbles:true}));})()")
      await fill(cdp, 'returnBattery', '65'); await confirm(); await dialogClosed(); await waitFor(cdp, textIncludes('Đã trả xe'), 'return confirmed')
      const result = sql(db => db.prepare("SELECT state,hub_id,battery_level FROM Vehicles WHERE vehicle_id='CAMPUS-V20'").get())
      assert.deepEqual(result, { state: 'AVAILABLE', hub_id: 'metro', battery_level: 65 })
      assert.equal(sql(db => db.prepare("SELECT COUNT(*) n FROM Reservations WHERE vehicle_id='CAMPUS-V20' AND state='COMPLETED'").get().n), 1)
      await running.close(); await launch(); await reload(); await selectHub('metro')
      assert.equal(await evaluate(cdp, `(${row('CAMPUS-V20')}).querySelector('.em-battery').innerText.includes('65%')`), true)
      assert.equal(sha(instance.env), savedKey)
      assert.deepEqual(sql(db => db.prepare("SELECT * FROM Reservations WHERE type='PARKING' ORDER BY reservation_id").all()), parkingBefore)
      evidence.persistence = { keyUnchanged: true, pickupNullHub: true, crossHubReturn: result, restart: true, parkingPreserved: true }
    })
    await t.test('cancel retains history; real second-user conflict/stranger rejection and GET-only recovery', async () => {
      await global(); await global(); await action('CAMPUS-V88', 'reserve'); await confirm(); await dialogClosed()
      await action('CAMPUS-V88', 'cancel', true); await confirm(); await dialogClosed()
      assert.equal(sql(db => db.prepare("SELECT COUNT(*) n FROM Reservations WHERE vehicle_id='CAMPUS-V88' AND state='CANCELLED'").get().n), 1)
      const otherCredentials = { email: 'vehicle-rival@example.invalid', password: 'VehicleRival!2026' }
      assert.equal((await request('/auth/register', otherCredentials)).status, 201)
      const rival = (await request('/auth/login', otherCredentials)).cookie
      await action('CAMPUS-V88', 'reserve')
      assert.equal((await request('/vehicles/CAMPUS-V88/reserve', {}, rival)).status, 201)
      const count = countPosts(); await confirm(); await waitFor(cdp, "!!document.querySelector('dialog [role=alert]')", 'real conflict')
      assert.equal(await evaluate(cdp, textIncludes('Phương tiện vừa được người khác đặt')), true); await screen('real-reservation-conflict')
      assert.equal((await browserRequest('/vehicles/CAMPUS-V88/pickup', {})).status, 403)
      assert.equal((await browserRequest('/vehicles/CAMPUS-V88/cancel', {})).status, 403)
      assert.equal((await browserRequest('/auth/me')).status, 200)
      await confirm(); await dialogClosed()
      // One dialog mutation plus two deliberately attempted stranger operations;
      // reconciliation must add no POST.
      assert.equal(countPosts(), count + 3)
      assert.equal((await request('/vehicles/CAMPUS-V88/cancel', {}, rival)).status, 200)
      await click(cdp, '.em-vehicle-controls > button'); await waitFor(cdp, `!!(${row('CAMPUS-V88')})?.querySelector('[data-vehicle-action=reserve]:not(:disabled)')`, 'rival cancellation refreshed')
    })
    await t.test('network/500/503 and lost committed POST never retry; successful POST survives failed GET refresh', async () => {
      const endpoint = '/vehicles/CAMPUS-V88/reserve'
      for (const fault of ['network', '500', '503']) {
        postFaults.set(endpoint, fault); await action('CAMPUS-V88', 'reserve'); const count = countPosts()
        await confirm(); await waitFor(cdp, "!!document.querySelector('dialog [role=alert]')", 'mutation failure ' + fault)
        assert.equal(sql(db => db.prepare("SELECT state FROM Vehicles WHERE vehicle_id='CAMPUS-V88'").get().state), 'AVAILABLE')
        postFaults.clear(); await confirm(); await dialogClosed(); assert.equal(countPosts(), count + 1)
      }
      postFaults.set(endpoint, 'lost'); await action('CAMPUS-V88', 'reserve'); const count = countPosts()
      await confirm(); await waitFor(cdp, "!!document.querySelector('dialog [role=alert]')", 'lost response')
      assert.equal(sql(db => db.prepare("SELECT state FROM Vehicles WHERE vehicle_id='CAMPUS-V88'").get().state), 'RESERVED')
      postFaults.clear(); await confirm(); await dialogClosed(); assert.equal(countPosts(), count + 1)
      assert.equal(await evaluate(cdp, "!!document.querySelector('[data-own-rentals] [data-vehicle-action=pickup]')"), true)
      await action('CAMPUS-V88', 'cancel', true); await confirm(); await dialogClosed()
      getFault = '503'; await action('CAMPUS-V88', 'reserve'); await confirm(); await dialogClosed()
      await waitFor(cdp, textIncludes('Chưa thể cập nhật danh sách'), 'post-success GET failure')
      assert.equal(await evaluate(cdp, textIncludes('Đã đặt xe')), true)
      assert.equal(await evaluate(cdp, "!!document.querySelector('[data-own-rentals] [data-vehicle-action=pickup]')"), true)
      await screen('confirmed-mutation-refresh-failure')
      getFault = null; await click(cdp, '.em-vehicle-controls > button'); await waitFor(cdp, "!document.querySelector('.em-vehicle-page [role=alert]')", 'refresh restored')
      await action('CAMPUS-V88', 'cancel', true); await confirm(); await dialogClosed()
      for (const fault of ['500', '503', 'network']) {
        getFault = fault; await click(cdp, '.em-vehicle-controls > button'); await waitFor(cdp, textIncludes('Chưa thể cập nhật danh sách'), 'GET failure ' + fault)
        assert.equal((await browserRequest('/auth/me')).status, 200)
        getFault = null; await click(cdp, '.em-vehicle-controls > button'); await waitFor(cdp, "!document.querySelector('.em-vehicle-page [role=alert]')", 'GET retry')
      }
    })
    await t.test('held Hub GET and pre-mutation GET cannot publish stale state after scope change/commit', async () => {
      const waitHeld = async () => { for (let i = 0; i < 100 && !held.length; i++) await delay(30); assert.ok(held.length > 0, 'intercepted real GET') }
      await click(cdp, '[aria-label="Phạm vi phương tiện"] button:first-child'); await waitVehicle()
      getFault = 'hold'; getMatch = 'hub_id=campus'
      await evaluate(cdp, "(()=>{const s=document.querySelector('[aria-label=\"Chọn Mobility Hub\"]');s.value='campus';s.dispatchEvent(new Event('change',{bubbles:true}));})()")
      await waitHeld(); await selectHub('metro'); getFault = null; getMatch = null; await release(); await delay(150)
      assert.equal(await evaluate(cdp, `!!(${row('CAMPUS-V88')})`), false)
      await global(); getFault = 'hold-response'; await click(cdp, '.em-vehicle-controls > button'); await waitHeld()
      await action('CAMPUS-V88', 'reserve'); getFault = null; await confirm(); await dialogClosed(); await release(); await delay(150)
      assert.equal(await evaluate(cdp, `(${row('CAMPUS-V88')}).querySelector('.em-badge').textContent`), 'Đã đặt')
      assert.equal(sql(db => db.prepare("SELECT state FROM Vehicles WHERE vehicle_id='CAMPUS-V88'").get().state), 'RESERVED')
      await action('CAMPUS-V88', 'cancel', true); await confirm(); await dialogClosed()
    })
    await t.test('visible15s polling, focus deduplication and hidden-page suspension use real GETs', async () => {
      const reads = () => evidence.requests.filter(r => r.method === 'GET' && r.path === '/vehicles').length
      await delay(200); const initial = reads(); await delay(15700); assert.ok(reads() > initial, 'visible polling refreshed without user action')
      getFault = 'hold'; await click(cdp, '.em-vehicle-controls > button')
      for (let i = 0; i < 100 && !held.length; i++) await delay(30)
      assert.ok(held.length); const heldCount = reads()
      await evaluate(cdp, "window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('focus'))")
      await delay(15700); assert.equal(reads(), heldCount, 'focus and polling share one outstanding request')
      getFault = null; await release(); await delay(150)
      await evaluate(cdp, "window.__vehicleHidden=true;Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.__vehicleHidden?'hidden':'visible'});document.dispatchEvent(new Event('visibilitychange'))")
      const hiddenCount = reads(); await delay(15700); assert.equal(reads(), hiddenCount, 'hidden visibility event suspends polling')
      await evaluate(cdp, "window.__vehicleHidden=false;document.dispatchEvent(new Event('visibilitychange'))")
      await waitVehicle(); await delay(200); assert.ok(reads() > hiddenCount, 'visibility return refreshes')
      assert.equal(await evaluate(cdp, "document.querySelector('[aria-label=\"Phạm vi phương tiện\"] button:nth-child(2)').getAttribute('aria-pressed')"), 'true')
      await evaluate(cdp, "delete document.visibilityState;delete window.__vehicleHidden")
      evidence.polling = { interval: 15000, visible: true, focusDeduplicated: true, hiddenEventSuspended: true }
    })
    await t.test('Vehicle/global/Mine/empty Hub, Overview module integration and five-width return-dialog visuals', async () => {
      await click(cdp, '[aria-label="Phạm vi phương tiện"] button:first-child'); await waitVehicle()
      await selectHub('new-campus'); assert.equal(await evaluate(cdp, textIncludes('Chưa có phương tiện trong phạm vi này')), true)
      await global(); await action('CAMPUS-V88', 'reserve'); await confirm(); await dialogClosed(); await action('CAMPUS-V88', 'pickup', true); await confirm(); await dialogClosed()
      await click(cdp, '[aria-label="Lọc phương tiện"] button:nth-child(3)')
      assert.equal(await evaluate(cdp, "document.querySelectorAll('[data-vehicle-id]').length"), 1)
      assert.equal(await evaluate(cdp, `(${row('CAMPUS-V88')}).querySelector('.em-hub-cell').textContent`), 'Đang di chuyển')
      await click(cdp, '[aria-label="Lọc phương tiện"] button:first-child')
      await evaluate(cdp, "document.querySelector('.em-toast > button')?.click()")
      for (const width of [1440, 1024, 720, 390, 320]) {
        await viewport(width); await delay(80); const m = await metrics(), reference = evidence.reference.find(x => x.width === width)
        assert.equal(m.overflow, false); assert.equal(m.columns.length, 6); assert.equal(m.primary, '#2563eb'); assert.equal(m.radius, '10px'); assert.equal(m.sticky, 'sticky'); assert.equal(m.battery, 37)
        if (width > 720) assert.ok(Math.abs(m.sidebar - reference.sidebar) < 1)
        if (width < 1024) assert.equal(m.internalScroll, true)
        evidence.vehicle.push(m); await screen('vehicle-' + width)
        await action('CAMPUS-V88', 'return', true)
        const bounds = await evaluate(cdp, `(()=>{const d=document.querySelector('dialog').getBoundingClientRect(),b=Array.from(document.querySelectorAll('dialog .em-dialog-footer button')).map(x=>x.getBoundingClientRect());return {width:innerWidth,left:d.left,right:d.right,dialogWidth:d.width,buttonsFit:b.every(x=>x.left>=d.left&&x.right<=d.right),noOverlap:b[0].right<=b[1].left||b[0].bottom<=b[1].top,labels:document.querySelectorAll('.em-return-fields label').length}})()`)
        assert.ok(bounds.left >= 15 && bounds.right <= width); assert.equal(bounds.buttonsFit, true); assert.equal(bounds.noOverlap, true); assert.equal(bounds.labels, 2)
        evidence.dialogs.push(bounds); await screen('return-dialog-' + width); await click(cdp, 'dialog .em-btn-cancel'); await dialogClosed()
      }
      await viewport(1440); await action('CAMPUS-V88', 'return', true)
      await evaluate(cdp, "(()=>{const s=document.querySelector('[name=returnHub]');s.value='campus';s.dispatchEvent(new Event('change',{bubbles:true}));})()")
      await fill(cdp, 'returnBattery', '80'); await confirm(); await dialogClosed()
      await click(cdp, '.em-nav-item:first-child'); await waitFor(cdp, "!!document.querySelector('[aria-label=\"Chọn phân hệ trong bảng\"]')", 'Overview selector')
      await evaluate(cdp, "(()=>{const s=document.querySelector('[aria-label=\"Chọn phân hệ trong bảng\"]');s.value='vehicle';s.dispatchEvent(new Event('change',{bubbles:true}));})()")
      await waitVehicle(); assert.equal(await evaluate(cdp, 'location.hash'), '#/overview/vehicle'); await screen('overview-vehicle-1440')
      await evaluate(cdp, "(()=>{const s=document.querySelector('[aria-label=\"Chọn phân hệ trong bảng\"]');s.value='parking';s.dispatchEvent(new Event('change',{bubbles:true}));})()")
      await waitFor(cdp, "document.querySelectorAll('thead th').length===4", 'Parking Overview unchanged')
      assert.equal(await evaluate(cdp, "document.querySelectorAll('.em-nav-item:disabled').length"), 1)
      await nav('.em-nav-item:nth-child(3)')
    })
    await t.test('expired Vehicle request clears identity through shared Auth; Login/Logout/direct route stay guarded', async () => {
      const userId = sql(db => db.prepare('SELECT user_id FROM Users WHERE email=?').get(credentials.email).user_id)
      const key = dotenv.parse(fs.readFileSync(instance.env)).JWT_SECRET
      const iat = Math.floor(Date.now() / 1000) - 3601
      const expired = jwt.sign({ sub: userId, iat, exp: iat + 3600, iss: 'smartemobilityhub-api', aud: 'smartemobilityhub-web' }, Buffer.from(key, 'hex'), { algorithm: 'HS256' })
      await cdp.send('Network.setCookie', { name: 'semh_auth', value: expired, url: BE, path: '/', httpOnly: true, sameSite: 'Lax' })
      await click(cdp, '.em-vehicle-controls > button'); await waitLogin(); assert.equal(await evaluate(cdp, textIncludes('Phiên đăng nhập đã hết hạn')), true)
      await fill(cdp, 'email', credentials.email); await fill(cdp, 'password', credentials.password); await evaluate(cdp, "document.querySelector('form').requestSubmit()")
      await waitFor(cdp, "!!document.querySelector('[data-protected-view]')", 'Login again'); await nav('.em-nav-item:nth-child(3)')
      await click(cdp, '.account-controls > .button'); await waitLogin()
      await evaluate(cdp, "location.hash='#/vehicle'"); await waitLogin(); assert.equal(await evaluate(cdp, "!!document.querySelector('[data-protected-view]')"), false)
      assert.equal(sha(instance.env), savedKey)
    })
    assert.deepEqual(evidence.exceptions, [])
  })
