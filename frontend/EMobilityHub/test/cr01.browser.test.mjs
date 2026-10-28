import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { browserPath, startBrowser, evaluate, waitFor, fill, click, textIncludes } from './browser-tools.mjs'

const require = createRequire(import.meta.url)
const { localDemoFixture } = require('../../../backend/test/local-demo.helpers.js')
const { openLocalDemo } = require('../../../backend/src/config/local-demo.js')
const { protectedSnapshot, testEnv } = require('../../../backend/test/helpers.js')
const fixture = require('../../../backend/demo/demo-data.json')
const jwt = require('../../../backend/node_modules/jsonwebtoken')
const dotenv = require('../../../backend/node_modules/dotenv')
const project = fileURLToPath(new URL('../../../', import.meta.url))
const FE = 'http://localhost:5173', BE = 'http://localhost:3000'

test('CR-01 real Chrome + root launcher + disk SQLite lifecycle, failures, persistence and responsive visuals',
  { skip: !browserPath && 'BROWSER_NOT_RUN', timeout: 300000 }, async t => {
    const before = protectedSnapshot()
    let running
    t.after(async () => { if (running) await running.close(); assert.deepEqual(protectedSnapshot(), before) })
    const instance = localDemoFixture(t, { fresh: true })
    async function launch() {
      const env = { ...testEnv(), HOST: 'localhost', PORT: '3000', VITE_DEV_PORT: '5173', DEMO_NAME: instance.name, COOKIE_SECURE: 'false' }
      delete env.FRONTEND_ORIGIN; delete env.VITE_API_BASE_URL
      const child = fork(path.join(project, 'scripts/dev-demo.js'), [], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      child.stderr.resume()
      const exited = once(child, 'exit')
      let stopping
      const close = () => stopping ||= (async () => {
        if (child.exitCode !== null) return
        child.send('shutdown')
        const timer = setTimeout(() => child.kill(), 12000)
        try { const [code] = await exited; assert.equal(code, 0) } finally { clearTimeout(timer) }
      })()
      running = { close }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('root launcher readiness timeout')), 30000)
        child.once('message', message => { clearTimeout(timer); message.ready ? resolve() : reject(new Error('invalid ready')) })
        child.once('exit', () => { clearTimeout(timer); reject(new Error('root launcher exited before ready')) })
      })
      return running
    }
    await launch()
    const cdp = await startBrowser(t)
    const output = process.env.SEMH_EVIDENCE_ROOT || path.join(project, 'frontend/EMobilityHub/.tmp')
    fs.mkdirSync(output, { recursive: true })
    const artifacts = fs.mkdtempSync(path.join(output, 'cr01-browser-'))
    const evidence = { tests: [], auth: [], parking: [], screenshots: [], runtimeExceptions: 0, mutations: [] }
    cdp.on('Runtime.exceptionThrown', () => evidence.runtimeExceptions++)
    cdp.on('Network.requestWillBeSent', ({ request }) => {
      if (request.url.startsWith(BE + '/hubs/') && request.method === 'POST') evidence.mutations.push({ path: new URL(request.url).pathname, fields: Object.keys(JSON.parse(request.postData || '{}')) })
    })
    const faults = new Map(), held = []
    await cdp.send('Fetch.enable', { patterns: ['Request', 'Response'].map(requestStage => ({ urlPattern: BE + '/hubs/*/parking-spaces/*/*', requestStage })) })
    cdp.on('Fetch.requestPaused', ({ requestId, request, responseStatusCode }) => {
      const fault = request.method === 'POST' && faults.get(new URL(request.url).pathname)
      if (responseStatusCode !== undefined) {
        if (fault === 'after-commit') void cdp.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' }).catch(() => {})
        else void cdp.send('Fetch.continueRequest', { requestId }).catch(() => {})
        return
      }
      if (fault === 'hold') { held.push(requestId); return }
      if (fault === 'network') void cdp.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' }).catch(() => {})
      else if (fault === '503') void cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 503, responseHeaders: [
        { name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: FE }, { name: 'Access-Control-Allow-Credentials', value: 'true' },
      ], body: Buffer.from(JSON.stringify({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', fieldErrors: {} } })).toString('base64') }).catch(() => {})
      else void cdp.send('Fetch.continueRequest', { requestId }).catch(() => {})
    })
    async function screen(name) {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
      fs.writeFileSync(path.join(artifacts, name + '.png'), Buffer.from(data, 'base64')); evidence.screenshots.push(name + '.png')
    }
    const viewport = width => cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
    const waitRows = () => waitFor(cdp, "!!document.querySelector('.em-resource-id strong')", 'Parking data')
    const waitLogin = () => waitFor(cdp, "location.hash==='#/login'&&!!document.querySelector('form')", 'Login')
    async function login() {
      await waitLogin(); await fill(cdp, 'email', fixture.users[0].email); await fill(cdp, 'password', fixture.password)
      await evaluate(cdp, "document.querySelector('form').requestSubmit()"); await waitRows()
    }
    const row = id => `Array.from(document.querySelectorAll('tbody tr')).find(r=>r.querySelector('strong')?.textContent===${JSON.stringify(id)})`
    const state = id => evaluate(cdp, `(${row(id)})?.querySelector('.em-badge')?.textContent`)
    async function action(id, operation) {
      await evaluate(cdp, `(${row(id)}).querySelector('[data-action="${operation}"]').click()`)
      await waitFor(cdp, "!!document.querySelector('dialog[open]')", 'confirmation dialog')
    }
    async function confirm() { await click(cdp, '[data-confirm-parking]') }
    const dialogClosed = () => waitFor(cdp, "!document.querySelector('dialog[open]')", 'dialog closed')
    async function reload() {
      const old = await evaluate(cdp, 'performance.timeOrigin')
      await cdp.send('Page.reload', { ignoreCache: true })
      await waitFor(cdp, `performance.timeOrigin!==${old}`, 'new document'); await waitRows()
    }
    function sql(fn) { const db = openLocalDemo(instance.name, { readonly: true }); try { return fn(db) } finally { db.close() } }
    async function selectHub(id) {
      await evaluate(cdp, `(()=>{const s=document.querySelector('[aria-label="Chọn Mobility Hub"]');s.value=${JSON.stringify(id)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`)
      await waitFor(cdp, `document.querySelector('[aria-label="Chọn Mobility Hub"]').value===${JSON.stringify(id)}&&!document.querySelector('.em-state[role=status]')`, 'Hub switched')
    }
    await viewport(1440); await cdp.send('Page.navigate', { url: FE + '/#/login' }); await waitLogin()

    await t.test('Login/Register split metrics, local illustration and usable submit at six widths', async () => {
      for (const mode of ['login', 'register']) {
        await evaluate(cdp, 'location.hash=' + JSON.stringify('#/' + mode))
        await waitFor(cdp, textIncludes(mode === 'login' ? 'Chào mừng bạn đến' : 'Tạo tài khoản sinh viên'), mode)
        for (const width of [1440, 1366, 1024, 720, 390, 320]) {
          await viewport(width)
          const metric = await evaluate(cdp, `(()=>{const r=s=>document.querySelector(s).getBoundingClientRect();const img=document.querySelector('.auth-scene');
            document.querySelector('[type=submit]').scrollIntoView({block:'nearest'});
            return {mode:${JSON.stringify(mode)},width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,
              hero:r('.auth-hero').width,panel:r('.auth-panel').width,card:r('.auth-card').width,input:r('input').height,
              submit:r('[type=submit]').height,submitVisible:r('[type=submit]').bottom<=innerHeight,
              scene:img.complete&&img.naturalWidth>0,sceneLocal:img.src.startsWith(location.origin),brand:document.body.innerText.includes('Smart E-Mobility Hub')};})()`)
          assert.equal(metric.overflow, false); assert.equal(metric.scene, true); assert.equal(metric.sceneLocal, true); assert.equal(metric.brand, true)
          assert.ok(metric.card >= 250 && metric.card <= 400); assert.equal(metric.input, 48); assert.equal(metric.submit, 48); assert.equal(metric.submitVisible, true)
          if (width >= 1366) assert.ok(Math.abs(metric.hero / width - .65) < .01)
          evidence.auth.push(metric)
          await evaluate(cdp, 'scrollTo(0,0)'); await screen(mode + '-' + width)
        }
      }
      await viewport(1440); await evaluate(cdp, "location.hash='#/login'"); await login()
    })

    await t.test('original owned reservation: cancel dialog/Escape/focus, then cancel through API/SQLite', async () => {
      assert.equal(await state('CAMPUS-02'), 'Đã đặt')
      await action('CAMPUS-02', 'release')
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await dialogClosed()
      await waitRows()
      assert.equal(await evaluate(cdp, `document.activeElement===(${row('CAMPUS-02')}).querySelector('[data-action="release"]')`), true)
      assert.equal(sql(db => db.prepare("SELECT state FROM ParkingSpaces WHERE space_id='CAMPUS-02'").get().state), 'RESERVED')
      await action('CAMPUS-02', 'release'); await screen('cancel-dialog'); await confirm(); await dialogClosed()
      assert.equal(await state('CAMPUS-02'), 'Còn trống')
      assert.equal(sql(db => db.prepare("SELECT state FROM Reservations WHERE space_id='CAMPUS-02'").get().state), 'CANCELLED')
    })

    await t.test('reserve pending/double-click, authoritative counts/banner and refresh persistence', async () => {
      const endpoint = '/hubs/campus/parking-spaces/CAMPUS-01/reserve'
      faults.set(endpoint, 'hold'); const before = evidence.mutations.length
      await action('CAMPUS-01', 'reserve'); await confirm()
      await waitFor(cdp, "document.querySelector('[data-confirm-parking]').disabled", 'pending disabled')
      await confirm()
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      assert.equal(await evaluate(cdp, "!!document.querySelector('dialog[open]')"), true)
      assert.equal(evidence.mutations.length - before, 1)
      assert.equal(sql(db => db.prepare("SELECT state FROM ParkingSpaces WHERE space_id='CAMPUS-01'").get().state), 'AVAILABLE')
      faults.delete(endpoint); for (const requestId of held.splice(0)) await cdp.send('Fetch.continueRequest', { requestId })
      await dialogClosed(); assert.equal(await state('CAMPUS-01'), 'Đã đặt')
      assert.equal(await evaluate(cdp, "document.querySelector('.em-summary-count').innerText.replaceAll(' ','').replaceAll(String.fromCharCode(10),'')"), '06/8')
      assert.equal(await evaluate(cdp, "document.querySelector('.em-reservation').innerText.includes('CAMPUS-01')"), true)
      assert.equal(await evaluate(cdp, "Array.from(document.querySelectorAll('[data-action=reserve]')).every(b=>b.disabled)"), true)
      await reload(); assert.equal(await state('CAMPUS-01'), 'Đã đặt')
      await selectHub('metro'); await waitFor(cdp, `!!(${row('METRO-01')})`, 'Metro')
      await click(cdp, '.em-reservation button'); await waitFor(cdp, `!!(${row('CAMPUS-01')})`, 'banner switches Hub')
      assert.equal(await evaluate(cdp, "document.querySelector('.em-filters button:nth-child(3)').getAttribute('aria-pressed')"), 'true')
      await click(cdp, '.em-filters button:first-child')
      await screen('reserved-dashboard')
    })

    await t.test('arrival + root process restart retains same cookie/account/occupied state; release persists', async () => {
      await action('CAMPUS-01', 'arrive'); await confirm(); await dialogClosed()
      assert.equal(await state('CAMPUS-01'), 'Đang sử dụng')
      assert.equal(sql(db => db.prepare("SELECT state FROM Reservations WHERE space_id='CAMPUS-01'").get().state), 'ACTIVE')
      await running.close(); await launch(); await reload()
      assert.equal(await state('CAMPUS-01'), 'Đang sử dụng')
      await action('CAMPUS-01', 'release'); await confirm(); await dialogClosed()
      assert.equal(await state('CAMPUS-01'), 'Còn trống')
      assert.equal(sql(db => db.prepare("SELECT state FROM Reservations WHERE space_id='CAMPUS-01'").get().state), 'COMPLETED')
      await running.close(); await launch(); await reload()
      assert.equal(await state('CAMPUS-01'), 'Còn trống')
    })

    await t.test('real other-student conflict and reload, network/server errors never fabricate success', async () => {
      const post = (route, cookie, body = {}) => fetch(BE + route, { method: 'POST', headers: { Origin: FE, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) })
      const otherLogin = await post('/auth/login', null, { email: fixture.users[2].email, password: fixture.password })
      const otherCookie = otherLogin.headers.get('set-cookie').split(';')[0]
      await post('/hubs/metro/parking-spaces/METRO-02/release', otherCookie)
      await action('CAMPUS-04', 'reserve')
      assert.equal((await post('/hubs/campus/parking-spaces/CAMPUS-04/reserve', otherCookie)).status, 201)
      await confirm(); await waitFor(cdp, "!!document.querySelector('dialog [role=alert]')", 'conflict')
      assert.equal(await evaluate(cdp, "document.querySelector('dialog').innerText.includes('Chỗ đỗ vừa được người khác đặt')"), true)
      await screen('conflict-dialog'); await confirm(); await dialogClosed()
      assert.equal(await state('CAMPUS-04'), 'Đã đặt')
      assert.equal(await evaluate(cdp, `(${row('CAMPUS-04')}).querySelectorAll('button').length`), 0)
      await post('/hubs/campus/parking-spaces/CAMPUS-04/release', otherCookie)
      await reload()
      for (const fault of ['network', '503']) {
        const endpoint = '/hubs/campus/parking-spaces/CAMPUS-05/reserve'
        faults.set(endpoint, fault)
        await action('CAMPUS-05', 'reserve'); await confirm()
        await waitFor(cdp, "!!document.querySelector('dialog [role=alert]')", fault + ' feedback')
        assert.equal(sql(db => db.prepare("SELECT state FROM ParkingSpaces WHERE space_id='CAMPUS-05'").get().state), 'AVAILABLE')
        assert.equal(await evaluate(cdp, "document.querySelector('[data-confirm-parking]').innerText"), 'Tải lại trạng thái')
        faults.delete(endpoint); await confirm(); await dialogClosed()
      }
      // Lose the response only after the real backend has committed. The UI
      // must reconcile via GET, without repeating a mutation that already won.
      const endpoint = '/hubs/campus/parking-spaces/CAMPUS-05/reserve'
      faults.set(endpoint, 'after-commit')
      await action('CAMPUS-05', 'reserve'); await confirm()
      await waitFor(cdp, "!!document.querySelector('dialog [role=alert]')", 'lost committed response')
      assert.equal(sql(db => db.prepare("SELECT state FROM ParkingSpaces WHERE space_id='CAMPUS-05'").get().state), 'RESERVED')
      assert.equal(await state('CAMPUS-05'), 'Còn trống')
      faults.delete(endpoint); await confirm(); await dialogClosed()
      assert.equal(await state('CAMPUS-05'), 'Đã đặt')
      await action('CAMPUS-05', 'release'); await confirm(); await dialogClosed()
    })

    await t.test('Parking/Overview controls, five widths/scroll/sticky table and no overlap', async () => {
      await click(cdp, '.em-nav-item:first-child'); await waitRows()
      assert.equal(await evaluate(cdp, "location.hash"), '#/overview')
      await click(cdp, '.em-summary:first-child'); await waitRows()
      for (const width of [1440, 1024, 720, 390, 320]) {
        await viewport(width)
        await evaluate(cdp, "document.querySelector('.em-table-scroll').scrollLeft=0")
        const metric = await evaluate(cdp, `(()=>{const r=s=>document.querySelector(s).getBoundingClientRect(), sc=document.querySelector('.em-table-scroll');
          return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,sidebar:r('.em-sidebar').width,
            header:r('.em-header').height,cards:getComputedStyle(document.querySelector('.em-cards')).gridTemplateColumns,
            sticky:getComputedStyle(document.querySelector('thead')).position,scroll:sc.scrollWidth>sc.clientWidth,
            toolbar:r('.em-table-toolbar').height,table:r('table').width};})()`)
        assert.equal(metric.overflow, false); assert.equal(metric.sticky, 'sticky'); if (width <= 720) assert.equal(metric.scroll, true)
        evidence.parking.push(metric); await screen('parking-' + width)
        await action('CAMPUS-06', 'reserve')
        const modal = await evaluate(cdp, `(()=>{const d=document.querySelector('dialog'),r=d.getBoundingClientRect(),a=d.querySelector('.em-btn-cancel').getBoundingClientRect(),b=d.querySelector('[data-confirm-parking]').getBoundingClientRect();
          return {width:r.width,height:r.height,left:r.left,right:r.right,buttonsOverlap:a.right>b.left,focus:document.activeElement===d.querySelector('.em-btn-cancel')};})()`)
        assert.ok(modal.left >= 15 && modal.right <= width - 15); assert.ok(modal.height <= 864)
        assert.equal(modal.buttonsOverlap, false); assert.equal(modal.focus, true)
        evidence.parking.at(-1).dialog = modal; await screen('dialog-' + width)
        await click(cdp, '.em-dialog .em-btn-cancel'); await dialogClosed()
      }
      await viewport(1440)
    })

    await t.test('expired cookie during mutation uses existing Auth guard and preserves meaningful expiry feedback', async () => {
      await action('CAMPUS-06', 'reserve')
      const id = sql(db => db.prepare('SELECT user_id FROM Users WHERE email=?').get(fixture.users[0].email).user_id)
      const key = dotenv.parse(fs.readFileSync(instance.env)).JWT_SECRET
      const iat = Math.floor(Date.now() / 1000) - 3601
      const value = jwt.sign({ sub: id, iat, exp: iat + 3600, iss: 'smartemobilityhub-api', aud: 'smartemobilityhub-web' }, Buffer.from(key, 'hex'), { algorithm: 'HS256' })
      await cdp.send('Network.setCookie', { name: 'semh_auth', value, url: BE, path: '/', httpOnly: true, sameSite: 'Lax' })
      await confirm(); await waitLogin()
      assert.equal(await evaluate(cdp, "!!document.querySelector('[data-protected-view]')"), false)
      assert.equal(sql(db => db.prepare("SELECT state FROM ParkingSpaces WHERE space_id='CAMPUS-06'").get().state), 'AVAILABLE')
      assert.equal(await evaluate(cdp, textIncludes('Phiên đăng nhập đã hết hạn.')), true)
    })
    await t.test('return after a real blur still rechecks the current SQLite account', async () => {
      await login()
      const db = openLocalDemo(instance.name)
      try { db.prepare("UPDATE Users SET status='INACTIVE' WHERE email=?").run(fixture.users[0].email) }
      finally { db.close() }
      await evaluate(cdp, "window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'))")
      await waitLogin()
      assert.equal(await evaluate(cdp, textIncludes('Tài khoản không hoạt động.')), true)
      assert.equal(await evaluate(cdp, "!!document.querySelector('[data-protected-view]')"), false)
    })
    assert.equal(evidence.runtimeExceptions, 0)
    assert.ok(evidence.mutations.every(m => m.fields.length === 0))
    evidence.tests = ['Auth6widths', 'cancel/focus', 'reserve/doubleclick/reload/banner', 'arrive/restart/release/restart', 'real409/network503/lost-committed-response/reload', 'Parking+dialogs5widths/Overview', 'mutation expiry', 'blur/current-account-recheck']
    fs.writeFileSync(path.join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2))
    console.log('CR01_BROWSER_EVIDENCE=' + artifacts)
  })
