import { useEffect, useRef, useState } from 'react'
import HubIcon from './HubIcon.jsx'
import { parkingErrorMessage } from '../Services/parking.js'

const copy = {
  reserve: ['Xác nhận đặt chỗ', 'Chỗ đỗ sẽ được giữ cho bạn. Khi đến bãi, hãy chọn “Đã đến bãi”.', 'Xác nhận đặt chỗ'],
  arrive: ['Bạn đã đến bãi?', 'Chỗ đỗ sẽ chuyển sang trạng thái đang sử dụng.', 'Xác nhận đến bãi'],
  release: ['Trả chỗ đỗ?', 'Chỗ đỗ sẽ được mở lại để sinh viên khác có thể đặt.', 'Xác nhận trả chỗ'],
}

export default function ParkingDialog({ selection, hubName, email, onConfirm, onReload, onClose, onPending }) {
  const dialog = useRef(null)
  const busy = useRef(false)
  const alive = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(null)
  const [title, detail, label] = copy[selection.action]
  useEffect(() => {
    alive.current = true
    const opener = selection.opener
    const node = dialog.current
    const nativeCancel = (event) => {
      event.preventDefault()
      if (!busy.current) onClose()
    }
    node.addEventListener('cancel', nativeCancel)
    node.showModal()
    node.querySelector('.em-btn-cancel')?.focus()
    return () => {
      alive.current = false
      node.removeEventListener('cancel', nativeCancel)
      node.close()
      if (opener?.isConnected && !opener.disabled) opener.focus()
      else {
        const heading = document.querySelector('#em-resource-title')
        if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus() }
      }
    }
  }, [selection.opener, onClose])
  async function run(reload = false) {
    if (busy.current) return
    busy.current = true; setPending(true); onPending(true)
    try {
      if (reload) await onReload()
      else await onConfirm(selection)
      if (alive.current) onClose()
    } catch (failure) {
      if (alive.current) setError(failure)
    } finally {
      busy.current = false
      if (alive.current) setPending(false)
      onPending(false)
    }
  }
  function cancel(event) {
    event?.preventDefault()
    if (!busy.current) onClose()
  }
  return <dialog ref={dialog} className="em-dialog" closedby={pending ? 'none' : 'closerequest'} aria-busy={pending} aria-labelledby="em-dialog-title" aria-describedby="em-dialog-detail"
    onKeyDown={(event) => { if (event.key === 'Escape' && busy.current) { event.preventDefault(); event.stopPropagation() } }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) cancel()
    }}>
    <div className="em-dialog-top"><span className="em-dialog-icon"><HubIcon name="parking" size={24} /></span>
      <button type="button" className="em-icon-button" aria-label="Đóng hộp thoại" disabled={pending} onClick={cancel}>×</button></div>
    <h2 id="em-dialog-title">{title}</h2><p id="em-dialog-detail">{detail}</p>
    <div className="em-booking-detail"><div><span>Tài nguyên</span><strong>{selection.space.space_id}</strong></div>
      <div><span>Mobility Hub</span><strong>{hubName}</strong></div><div><span>Sinh viên</span><strong>{email} · Của bạn</strong></div></div>
    {error && <p className="notice notice-error" role="alert">{parkingErrorMessage(error)} Chưa xác nhận kết quả thao tác. Tải lại trạng thái trước khi tiếp tục.</p>}
    <div className="em-dialog-footer"><button autoFocus type="button" className="em-btn em-btn-cancel" disabled={pending} onClick={cancel}>Quay lại</button>
      <button type="button" className="em-btn em-btn-primary" data-confirm-parking disabled={pending} onClick={() => { void run(Boolean(error)) }}>
        {pending ? 'Đang xử lý…' : error ? 'Tải lại trạng thái' : label}</button></div>
  </dialog>
}
