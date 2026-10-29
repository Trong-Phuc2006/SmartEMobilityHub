import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AppShell from '../Components/AppShell.jsx'
import ParkingSummary from '../Components/ParkingSummary.jsx'
import VehicleTable, { VehicleActions } from '../Components/VehicleTable.jsx'
import VehicleDialog from '../Components/VehicleDialog.jsx'
import HubIcon from '../Components/HubIcon.jsx'
import { createParkingApi } from '../Services/parking.js'
import { createVehicleApi, createVehicleLoader, vehicleErrorMessage, vehicleSummary } from '../Services/vehicle.js'
import { navigate } from '../Services/navigation.js'
import './ParkingDashboard.css'
import './VehicleDashboard.css'

export default function VehicleDashboard({ http, user, route, pending, onLogout, initialHub = '', initialScope = 'hub', onSelectedHub, onVehicleScope, onBusy }) {
  const api = useMemo(() => createVehicleApi(http), [http])
  const parkingApi = useMemo(() => createParkingApi(http), [http])
  const startHub = useRef(initialHub)
  const [hubs, setHubs] = useState({ status: 'loading', rows: [], error: null })
  const [selectedHub, setSelectedHub] = useState(''), [scope, setScope] = useState(initialScope)
  const [data, setData] = useState(null), [error, setError] = useState(null), [refreshError, setRefreshError] = useState(null)
  const [ownRows, setOwnRows] = useState([])
  const [parkingSummary, setParkingSummary] = useState(null), [attempt, setAttempt] = useState(0)
  const [filter, setFilter] = useState('all'), [search, setSearch] = useState('')
  const [selection, setSelection] = useState(null), [actionPending, setActionPending] = useState(false), [feedback, setFeedback] = useState('')
  const [today] = useState(() => new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }))
  const overview = route === '#/overview/vehicle'
  const hubId = scope === 'global' ? undefined : selectedHub
  const hub = hubs.rows.find(h => h.hub_id === selectedHub)
  const loader = useMemo(() => createVehicleLoader(api, {
    onData: next => { setData(next); setOwnRows(next.reservations); setError(null); setRefreshError(null) },
    onError: failure => { setError(failure); setRefreshError(failure) },
  }), [api])
  const busy = pending || actionPending || Boolean(selection)
  const closeDialog = useCallback(() => setSelection(null), [])
  const reportPending = useCallback(value => { setActionPending(value); onBusy?.(value) }, [onBusy])
  useEffect(() => () => { onBusy?.(false) }, [onBusy])
  useEffect(() => {
    const controller = new AbortController(); let current = true
    parkingApi.hubs({ signal: controller.signal }).then(rows => {
      if (!current) return
      setHubs({ status: 'ready', rows, error: null })
      const id = rows.some(h => h.hub_id === startHub.current) ? startHub.current : rows[0]?.hub_id || ''
      setSelectedHub(id); onSelectedHub?.(id)
    }).catch(failure => { if (current && !controller.signal.aborted) setHubs({ status: 'error', rows: [], error: failure }) })
    return () => { current = false; controller.abort() }
  }, [parkingApi, attempt, onSelectedHub])
  useEffect(() => {
    if (hubs.status !== 'ready' || (scope === 'hub' && !selectedHub) || selection || pending) return
    const refresh = () => { if (document.visibilityState !== 'hidden') void loader.load(hubId).catch(() => {}) }
    refresh()
    const timer = setInterval(refresh, 15000)
    const visibility = () => { if (document.visibilityState === 'hidden') loader.cancel(); else refresh() }
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', visibility)
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visibility); loader.cancel() }
  }, [loader, hubId, hubs.status, scope, selectedHub, selection, pending])
  useEffect(() => {
    if (!selectedHub) return
    const controller = new AbortController(); let current = true
    parkingApi.spaces(selectedHub, { signal: controller.signal }).then(result => { if (current) setParkingSummary(result.summary) }).catch(() => { if (current) setParkingSummary(null) })
    return () => { current = false; controller.abort() }
  }, [parkingApi, selectedHub])
  useEffect(() => { if (!feedback) return; const timer = setTimeout(() => setFeedback(''), 6500); return () => clearTimeout(timer) }, [feedback])
  function reset() { setFilter('all'); setSearch('') }
  function changeHub(id) {
    if (busy || id === selectedHub) return
    loader.cancel(); setSelectedHub(id); onSelectedHub?.(id); setData(null); setError(null); setRefreshError(null); setParkingSummary(null); reset()
  }
  function changeScope(value) {
    if (busy || value === scope) return
    loader.cancel(); setScope(value); onVehicleScope?.(value); setData(null); setError(null); setRefreshError(null); reset()
  }
  async function refresh() {
    if (!await loader.load(hubId, { replace: true })) throw new Error('Cancelled Vehicle refresh')
  }
  function open(v, action, opener) { loader.cancel(); setSelection({ vehicle: v, action, opener }) }
  async function confirm({ vehicle, action }, body) {
    loader.cancel() // A held GET can never overwrite the mutation result.
    const result = await api.mutate(vehicle.vehicle_id, action, body)
    setOwnRows(result.reservations)
    setData(previous => {
      if (!previous) return null
      const rows = (previous?.vehicles || []).filter(v => v.vehicle_id !== result.vehicle.vehicle_id)
      if (hubId === undefined || result.vehicle.hub_id === hubId) rows.push(result.vehicle)
      rows.sort((a, b) => a.vehicle_id.localeCompare(b.vehicle_id))
      return { vehicles: rows, summary: vehicleSummary(rows), reservations: result.reservations }
    })
    setError(null); setRefreshError(null)
    setFeedback(({ reserve: 'Đã đặt xe', pickup: 'Đã nhận xe', return: 'Đã trả xe', cancel: 'Đã hủy đặt xe' })[action] + ' · ' + result.vehicle.vehicle_id)
    // Closing the dialog resumes the GET refresh/poll effect. Its failure is
    // separate from this already confirmed mutation success.
  }
  const failure = hubs.error || error
  return <AppShell user={user} route={route} pending={busy} onLogout={onLogout} hubs={hubs.rows} selectedHub={selectedHub}
    hubsLoading={hubs.status === 'loading'} onHubChange={changeHub}>
    <main className="em-main em-vehicle-page" aria-busy={hubs.status === 'loading' || (!data && !failure && (scope === 'global' || Boolean(selectedHub)))}>
      <div className="em-overview-heading"><div><h1>{overview ? 'Tổng quan Mobility Hub' : 'Thuê phương tiện'}</h1><p>{scope === 'global' ? 'Toàn mạng lưới Mobility Hub' : hub?.name || 'Thông tin phương tiện tại Mobility Hub'}</p></div><div className="em-date">{today}<span><i />Dữ liệu demo · SQLite</span></div></div>
      <ParkingSummary summary={parkingSummary} vehicleSummary={data?.summary} overview={overview} activeModule="vehicle" pending={busy} />
      <p className="em-vehicle-scope-note">Phương tiện: {scope === 'global' ? 'toàn mạng lưới' : hub?.name || 'Hub hiện tại'} · Chỗ đỗ: {hub?.name || 'Hub hiện tại'}</p>
      <section className="em-resource-section" aria-labelledby="em-resource-title">
        <div className="em-section-heading"><div><div className="em-eyebrow">{scope === 'global' ? 'DỊCH VỤ TOÀN MẠNG LƯỚI' : 'DỊCH VỤ TẠI ' + (hub?.name || 'MOBILITY HUB')}</div><div className="em-table-title"><h2 id="em-resource-title">{overview ? 'Danh sách tài nguyên' : 'Thuê phương tiện'}<span>{data?.summary.total_vehicles ?? '—'}</span></h2>
          {overview && <label className="em-module-select"><select aria-label="Chọn phân hệ trong bảng" value="vehicle" disabled={busy} onChange={() => navigate('#/overview')}><option value="parking">Bãi đỗ xe</option><option value="vehicle">Thuê phương tiện</option><option disabled>Trạm sạc · Chưa triển khai</option></select><HubIcon name="down" size={14} /></label>}</div><p>Chọn phương tiện cho hành trình tiếp theo của bạn.</p></div></div>
        <div className="em-vehicle-controls"><div className="em-filters" role="group" aria-label="Phạm vi phương tiện">{[['hub', 'Hub hiện tại'], ['global', 'Toàn mạng lưới']].map(([id, label]) => <button type="button" key={id} aria-pressed={scope === id} disabled={busy} className={scope === id ? 'em-filter-active' : ''} onClick={() => changeScope(id)}>{label}</button>)}</div>
          <button type="button" className="em-text-button" disabled={busy || hubs.status !== 'ready' || (scope === 'hub' && !selectedHub)} onClick={() => { void refresh().catch(() => {}) }}>Tải lại phương tiện</button></div>
        {ownRows.length > 0 && <div className="em-reservation em-vehicle-reservation" data-own-rentals>
          <span className="em-reservation-icon"><HubIcon name="check" size={19} /></span><div><strong>Phương tiện của bạn · {ownRows.length} lượt</strong>
            {ownRows.map(v => <div className="em-own-rental" key={v.vehicle_id}><span>{v.vehicle_id} · {v.state === 'IN_USE' ? 'Đang sử dụng · Đang di chuyển' : 'Đã đặt · ' + v.hub_name}</span><div className="em-own-actions"><VehicleActions vehicle={v} pending={busy} hasRental onAction={open} /></div></div>)}
            {ownRows.length > 1 && <p role="status">Có nhiều lượt thuê đang mở từ dữ liệu cũ. Hãy kết thúc từng lượt trước khi đặt mới.</p>}</div>
          <button type="button" className="em-text-button" disabled={busy} onClick={() => { if (scope !== 'global') changeScope('global'); setFilter('mine'); setSearch('') }}>Xem đặt chỗ <HubIcon name="arrow" size={16} /></button>
        </div>}
        {!data && !failure && (hubs.status === 'loading' || scope === 'global' || selectedHub) && <div className="em-state em-table-card" role="status">Đang tải phương tiện…</div>}
        {failure && !data && <div className="em-state em-table-card"><p role="alert">{vehicleErrorMessage(failure)}</p><button type="button" className="button button-primary" onClick={() => { if (hubs.error) { setHubs({ status: 'loading', rows: [], error: null }); setAttempt(v => v + 1) } else void refresh().catch(() => {}) }}>Thử lại</button></div>}
        {refreshError && data && <p className="notice notice-error" role="alert">Chưa thể cập nhật danh sách. {vehicleErrorMessage(refreshError)} Dữ liệu đang hiển thị là lần xác nhận gần nhất. <button type="button" className="em-text-button" onClick={() => { void refresh().catch(() => {}) }}>Thử lại</button></p>}
        {hubs.status === 'ready' && !hubs.rows.length && scope === 'hub' && <div className="em-state em-table-card">Chưa có Mobility Hub. Chọn Toàn mạng lưới để kiểm tra phương tiện.</div>}
        {data && <VehicleTable vehicles={data.vehicles} filter={filter} search={search} onFilter={setFilter} onSearch={setSearch} onReset={reset} pending={busy} hasRental={ownRows.length > 0} onAction={open} />}
        <div className="em-footnote"><HubIcon name="info" size={15} /><span>Mỗi sinh viên có tối đa 1 phương tiện đang đặt hoặc sử dụng. Cần pin từ 20% để đặt xe.</span></div>
      </section>
    </main>
    {selection && <VehicleDialog selection={selection} hubs={hubs.rows} email={user.email} onConfirm={confirm} onReload={refresh} onClose={closeDialog} onPending={reportPending} />}
    <div className="em-notice-region" aria-live="polite" aria-atomic="true">{feedback && <div className="em-toast"><span className="em-toast-icon"><HubIcon name="check" size={18} /></span><div><strong>Thành công</strong><p>{feedback}</p></div><button type="button" aria-label="Đóng thông báo" onClick={() => setFeedback('')}>×</button></div>}</div>
  </AppShell>
}
