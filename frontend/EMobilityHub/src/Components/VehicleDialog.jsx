import { useEffect, useRef, useState } from 'react'
import HubIcon from './HubIcon.jsx'
import { vehicleErrorMessage } from '../Services/vehicle.js'

const copy = {
  reserve: ['Xác nhận đặt xe', 'Phương tiện sẽ được giữ cho bạn. Chọn “Nhận xe” khi bắt đầu hành trình.', 'Xác nhận đặt xe'],
  pickup: ['Xác nhận nhận xe', 'Phương tiện sẽ chuyển sang đang sử dụng và rời Hub hiện tại.', 'Bắt đầu sử dụng'],
  return: ['Xác nhận trả xe', 'Chọn Hub đã trả xe và nhập mức pin sau hành trình (thông tin mô phỏng).', 'Xác nhận trả xe'],
  cancel: ['Hủy đặt xe?', 'Lượt đặt sẽ kết thúc. Phương tiện sẽ được mở lại cho sinh viên khác.', 'Xác nhận hủy đặt'],
}
export default function VehicleDialog({ selection, hubs, email, onConfirm, onReload, onClose, onPending }) {
  const dialog = useRef(null), busy = useRef(false), alive = useRef(false)
  const [pending, setPending] = useState(false), [error, setError] = useState(null)
  const [hubId, setHubId] = useState(''), [battery, setBattery] = useState(''), [validation, setValidation] = useState('')
  const [title, detail, label] = copy[selection.action]
  useEffect(() => {
    alive.current = true
    const node = dialog.current, opener = selection.opener
    const cancel = event => { event.preventDefault(); if (!busy.current) onClose() }
    node.addEventListener('cancel', cancel); node.showModal(); node.querySelector('.em-btn-cancel')?.focus()
    return () => {
      alive.current = false; node.removeEventListener('cancel', cancel); node.close()
      if (opener?.isConnected && !opener.disabled) opener.focus()
      else { const heading = document.querySelector('#em-resource-title'); heading?.setAttribute('tabindex', '-1'); heading?.focus() }
    }
  }, [onClose, selection.opener])
  async function run() {
    if (busy.current) return
    let body = {}
    if (!error && selection.action === 'return') {
      if (!hubId || !/^\d+$/.test(battery) || !Number.isInteger(Number(battery)) || Number(battery) > 100) {
        setValidation('Chọn Hub trả xe và nhập mức pin là số nguyên từ 0 đến 100.'); return
      }
      body = { hub_id: hubId, battery_level: Number(battery) }
    }
    busy.current = true; setPending(true); onPending(true)
    try {
      if (error) await onReload()
      else await onConfirm(selection, body)
      if (alive.current) onClose()
    } catch (failure) { if (alive.current) setError(failure) }
    finally { busy.current = false; if (alive.current) setPending(false); onPending(false) }
  }
  const close = () => { if (!busy.current) onClose() }
  return <dialog ref={dialog} className="em-dialog em-vehicle-dialog" closedby={pending ? 'none' : 'closerequest'} aria-busy={pending}
    aria-labelledby="vehicle-dialog-title" aria-describedby="vehicle-dialog-detail"
    onKeyDown={event => { if (event.key === 'Escape' && busy.current) { event.preventDefault(); event.stopPropagation() } }}
    onClick={event => { if (event.target !== event.currentTarget) return; const b = event.currentTarget.getBoundingClientRect(); if (event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom) close() }}>
    <div className="em-dialog-top"><span className="em-dialog-icon"><HubIcon name="vehicle" size={24} /></span><button type="button" className="em-icon-button" aria-label="Đóng hộp thoại" disabled={pending} onClick={close}>×</button></div>
    <h2 id="vehicle-dialog-title">{title}</h2><p id="vehicle-dialog-detail">{detail}</p>
    <div className="em-booking-detail"><div><span>Phương tiện</span><strong>{selection.vehicle.vehicle_id}</strong></div><div><span>Mobility Hub</span><strong>{selection.vehicle.hub_name ?? 'Đang di chuyển'}</strong></div><div><span>Sinh viên</span><strong>{email} · Của bạn</strong></div></div>
    {selection.action === 'return' && <fieldset className="em-return-fields" disabled={pending || Boolean(error)}><label htmlFor="vehicle-return-hub">Hub trả xe</label>
      <select id="vehicle-return-hub" name="returnHub" value={hubId} onChange={event => { setHubId(event.target.value); setValidation('') }}><option value="">Chọn Hub trả xe…</option>{hubs.map(h => <option key={h.hub_id} value={h.hub_id}>{h.name}</option>)}</select>
      <label htmlFor="vehicle-return-battery">Mức pin sau hành trình (%)</label><input id="vehicle-return-battery" name="returnBattery" type="number" min="0" max="100" step="1" value={battery} onChange={event => { setBattery(event.target.value); setValidation('') }} /></fieldset>}
    {validation && <p className="notice notice-error" role="alert">{validation}</p>}
    {error && <p className="notice notice-error" role="alert">{vehicleErrorMessage(error)} Chưa xác nhận kết quả thao tác. Tải lại trạng thái trước khi tiếp tục.</p>}
    <div className="em-dialog-footer"><button type="button" autoFocus className="em-btn em-btn-cancel" disabled={pending} onClick={close}>Quay lại</button>
      <button type="button" className="em-btn em-btn-primary" data-confirm-vehicle disabled={pending} onClick={() => { void run() }}>{pending ? 'Đang xử lý…' : error ? 'Tải lại trạng thái' : label}</button></div>
  </dialog>
}
