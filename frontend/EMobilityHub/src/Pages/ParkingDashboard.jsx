import { useCallback, useEffect, useRef, useState } from 'react'
import AppShell from '../Components/AppShell.jsx'
import ParkingSummary from '../Components/ParkingSummary.jsx'
import ParkingTable from '../Components/ParkingTable.jsx'
import HubIcon from '../Components/HubIcon.jsx'
import ParkingDialog from '../Components/ParkingDialog.jsx'
import { createParkingApi, parkingErrorMessage } from '../Services/parking.js'
import { createVehicleApi } from '../Services/vehicle.js'
import { navigate } from '../Services/navigation.js'
import './ParkingDashboard.css'

export default function ParkingDashboard({ http, user, route, pending, onLogout, initialHub = '', onSelectedHub }) {
  const [api] = useState(() => createParkingApi(http))
  const [vehicleApi] = useState(() => createVehicleApi(http))
  const startHub = useRef(initialHub)
  const [vehicleData, setVehicleData] = useState(null)
  const [hubs, setHubs] = useState({ status: 'loading', rows: [], error: null })
  const [selectedHub, setSelectedHub] = useState('')
  const [parking, setParking] = useState({ status: 'loading', data: null, error: null })
  const [hubsAttempt, setHubsAttempt] = useState(0)
  const [parkingAttempt, setParkingAttempt] = useState(0)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [reservations, setReservations] = useState([])
  const [selection, setSelection] = useState(null)
  const [actionPending, setActionPending] = useState(false)
  const [feedback, setFeedback] = useState(null)
  const closeDialog = useCallback(() => setSelection(null), [])
  const [today] = useState(() => new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }))
  const overview = route === '#/overview'
  useEffect(() => {
    const controller = new AbortController()
    // Both signal and closure guard: late results cannot publish after teardown,
    // even if a transport does not honor cancellation (StrictMode included).
    let current = true
    api.hubs({ signal: controller.signal }).then((rows) => {
      if (!current) return
      setHubs({ status: 'ready', rows, error: null })
      const id = rows.some(row => row.hub_id === startHub.current) ? startHub.current : rows[0]?.hub_id || ''
      setSelectedHub(id); onSelectedHub?.(id)
    }).catch((error) => {
      if (current && !controller.signal.aborted) setHubs({ status: 'error', rows: [], error })
    })
    return () => { current = false; controller.abort() }
  }, [api, hubsAttempt, onSelectedHub])
  useEffect(() => {
    if (!selectedHub) return
    const controller = new AbortController(); let current = true
    vehicleApi.list(selectedHub, { signal: controller.signal }).then(data => {
      if (current) setVehicleData({ hubId: selectedHub, summary: data.summary })
    }).catch(() => { if (current) setVehicleData(null) })
    return () => { current = false; controller.abort() }
  }, [vehicleApi, selectedHub])
  useEffect(() => {
    if (!selectedHub) return
    const controller = new AbortController()
    let current = true
    Promise.all([api.spaces(selectedHub, { signal: controller.signal }), api.reservations({ signal: controller.signal })]).then(([data, own]) => {
      if (current) { setParking({ status: 'ready', data, error: null }); setReservations(own) }
    }).catch((error) => {
      if (current && !controller.signal.aborted) setParking({ status: 'error', data: null, error })
    })
    return () => { current = false; controller.abort() }
  }, [api, selectedHub, parkingAttempt])
  useEffect(() => {
    if (!feedback) return
    const timer = setTimeout(() => setFeedback(null), 6500)
    return () => clearTimeout(timer)
  }, [feedback])
  function reset() { setFilter('all'); setSearch('') }
  function changeHub(id) {
    if (actionPending) return
    setParking({ status: 'loading', data: null, error: null })
    reset()
    setSelectedHub(id)
    onSelectedHub?.(id)
  }
  function retryHubs() {
    setHubs({ status: 'loading', rows: [], error: null })
    setSelectedHub('')
    setParking({ status: 'loading', data: null, error: null })
    reset()
    setHubsAttempt((value) => value + 1)
  }
  function retryParking() {
    setParking({ status: 'loading', data: null, error: null })
    setParkingAttempt((value) => value + 1)
  }
  async function reloadState() {
    const [data, own] = await Promise.all([api.spaces(selectedHub), api.reservations()])
    setParking({ status: 'ready', data, error: null }); setReservations(own)
  }
  async function confirmAction({ space, action }) {
    const result = await api.mutate(space.hub_id, space.space_id, action)
    setParking({ status: 'ready', data: result.parking, error: null })
    setReservations(result.reservations)
    setFeedback(({ reserve: 'Đã đặt chỗ', arrive: 'Đã xác nhận đến bãi', release: 'Đã trả chỗ' })[action] + ' · ' + space.space_id)
  }
  function showReservation() {
    const reservation = reservations[0]
    if (!reservation) return
    if (reservation.hub_id !== selectedHub) changeHub(reservation.hub_id)
    setFilter('mine'); setSearch('')
  }
  const data = hubs.status === 'ready' && parking.status === 'ready' && parking.data.hub.hub_id === selectedHub ? parking.data : null
  const hub = hubs.rows.find((row) => row.hub_id === selectedHub)
  const error = hubs.error || parking.error
  const loading = hubs.status === 'loading' || (hubs.status === 'ready' && hubs.rows.length > 0 && parking.status === 'loading')
  return <AppShell user={user} route={route} pending={pending || actionPending} onLogout={onLogout} hubs={hubs.rows}
    selectedHub={selectedHub} hubsLoading={hubs.status === 'loading'} onHubChange={changeHub}>
    <main className="em-main" aria-busy={Boolean(loading)}>
      <div className="em-overview-heading"><div><h1>{overview ? 'Tổng quan Mobility Hub' : 'Bãi đỗ xe'}</h1>
        <p>{hub ? [hub.name, hub.location_type].filter(Boolean).join(' · ') : 'Thông tin dịch vụ tại Mobility Hub'}</p></div>
        <div className="em-date">{today}<span><i />Dữ liệu demo · SQLite</span></div>
      </div>
      <ParkingSummary summary={data?.summary} vehicleSummary={vehicleData?.hubId === selectedHub ? vehicleData.summary : null} overview={overview} pending={pending} />
      <section className="em-resource-section" aria-labelledby="em-resource-title">
        <div className="em-section-heading"><div><div className="em-eyebrow">DỊCH VỤ TẠI {hub?.name || 'MOBILITY HUB'}</div>
          <div className="em-table-title"><h2 id="em-resource-title">{overview ? 'Danh sách tài nguyên' : 'Bãi đỗ xe'}<span>{data ? data.summary.total_spaces : '—'}</span></h2>
            {overview && <label className="em-module-select"><select aria-label="Chọn phân hệ trong bảng" value="parking" disabled={pending || actionPending} onChange={() => navigate('#/overview/vehicle')}>
              <option value="parking">Bãi đỗ xe</option><option value="vehicle">Thuê phương tiện</option><option disabled>Trạm sạc · Chưa triển khai</option>
            </select><HubIcon name="down" size={14} /></label>}
          </div><p>Xem tình trạng và chỗ đỗ của bạn trong Hub hiện tại.</p></div></div>
        {reservations.length > 0 && <div className="em-reservation"><span className="em-reservation-icon"><HubIcon name="check" size={19} /></span>
          <div><strong>Chỗ đỗ của bạn · {reservations.length} chỗ</strong><span>{reservations[0].space_id} · {reservations[0].hub_name}</span></div>
          <button className="em-text-button" type="button" disabled={pending || actionPending} onClick={showReservation}>Xem đặt chỗ <HubIcon name="arrow" size={16} /></button>
        </div>}
        {data && data.hub.total_parking_capacity !== data.summary.total_spaces && <p className="em-capacity-notice" role="status">
          Sức chứa cấu hình: {data.hub.total_parking_capacity}; số chỗ đã lưu: {data.summary.total_spaces}.</p>}
        {loading && <div className="em-state em-table-card" role="status">{hubs.status === 'loading' ? 'Đang tải Mobility Hub…' : 'Đang tải chỗ đỗ xe…'}</div>}
        {error && <div className="em-state em-table-card"><p role="alert">{parkingErrorMessage(error)}</p>
          <button className="button button-primary" type="button" onClick={hubs.error || error.code === 'HUB_NOT_FOUND' ? retryHubs : retryParking}>Thử lại</button></div>}
        {hubs.status === 'ready' && !hubs.rows.length && <div className="em-state em-table-card"><HubIcon name="location" size={30} />
          <strong>Chưa có Mobility Hub</strong><p>Chưa có dữ liệu Hub trong SQLite.</p><button className="em-text-button" type="button" onClick={retryHubs}>Tải lại</button></div>}
        {data && <ParkingTable spaces={data.spaces} filter={filter} search={search} onFilter={setFilter} onSearch={setSearch} onReset={reset}
          onAction={(space, action, opener) => setSelection({ space, action, opener })} pending={pending || actionPending} hasReservation={reservations.length > 0} />}
        <div className="em-footnote"><HubIcon name="info" size={15} /><span>Mỗi sinh viên có tối đa 1 chỗ đỗ đang đặt hoặc sử dụng. Chỉ quản lý chỗ đỗ của bạn.</span></div>
      </section>
    </main>
    {selection && <ParkingDialog selection={selection} hubName={hub?.name} email={user.email} onConfirm={confirmAction}
      onReload={reloadState} onClose={closeDialog} onPending={setActionPending} />}
    <div className="em-notice-region" aria-live="polite" aria-atomic="true">{feedback && <div className="em-toast">
      <span className="em-toast-icon"><HubIcon name="check" size={18} /></span><div><strong>Thành công</strong><p>{feedback}</p></div>
      <button type="button" aria-label="Đóng thông báo" onClick={() => setFeedback(null)}>×</button></div>}</div>
  </AppShell>
}
