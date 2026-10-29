import HubIcon from './HubIcon.jsx'
import VehicleBattery from './VehicleBattery.jsx'
import { canReserveVehicle, filterVehicles, vehicleOwnerLabel, vehicleStatus } from '../Services/vehicle.js'

export function VehicleActions({ vehicle: v, pending, hasRental, onAction }) {
  const button = (action, text, className) => <button key={action} type="button" data-vehicle-action={action} className={'em-btn ' + className}
    disabled={pending} onClick={event => onAction(v, action, event.currentTarget)}>{text}</button>
  if (v.state === 'AVAILABLE') return <button type="button" className="em-btn em-btn-outline" data-vehicle-action="reserve"
    disabled={pending || hasRental || !canReserveVehicle(v)} title={v.battery_level < 20 ? 'Cần pin từ 20% để đặt xe' : hasRental ? 'Hãy kết thúc lượt thuê hiện tại trước' : undefined}
    onClick={event => onAction(v, 'reserve', event.currentTarget)}>Đặt xe <HubIcon name="arrow" size={14} /></button>
  if (v.is_mine) return v.state === 'RESERVED' ? <>{button('pickup', 'Nhận xe', 'em-btn-primary')}{button('cancel', 'Hủy đặt', 'em-btn-quiet')}</>
    : button('return', 'Trả xe', 'em-btn-primary')
  return <span className="em-unavailable"><HubIcon name="lock" size={13} />{v.state === 'UNAVAILABLE' ? 'Không khả dụng' : 'Không thuộc bạn'}</span>
}
export default function VehicleTable({ vehicles, filter, search, onFilter, onSearch, onReset, pending, hasRental, onAction }) {
  const rows = filterVehicles(vehicles, filter, search)
  return <div className="em-table-card em-vehicle-table">
    <div className="em-table-toolbar">
      <div className="em-filters" role="group" aria-label="Lọc phương tiện">{[['all', 'Tất cả'], ['available', 'Khả dụng'], ['mine', 'Của tôi']].map(([id, label]) =>
        <button key={id} type="button" disabled={pending} aria-pressed={filter === id} className={filter === id ? 'em-filter-active' : ''} onClick={() => onFilter(id)}>{label}{id === 'all' && <span>{vehicles.length}</span>}</button>)}</div>
      <label className="em-search"><HubIcon name="search" size={17} /><input type="search" name="vehicleSearch" aria-label="Tìm mã xe hoặc loại xe"
        placeholder="Tìm mã xe hoặc loại xe…" value={search} disabled={pending} onChange={event => onSearch(event.target.value)} /></label>
    </div>
    <div className="em-table-scroll" role="region" aria-label="Danh sách phương tiện" tabIndex={0}>
      <table><caption className="em-sr-only">Phương tiện cho thuê</caption><thead><tr>{['Phương tiện', 'Mức pin', 'Mobility Hub', 'Trạng thái', 'Người sử dụng', 'Thao tác'].map((title, index) =>
        <th scope="col" key={title} className={index === 5 ? 'em-actions-heading' : undefined}>{title}</th>)}</tr></thead>
      <tbody>{rows.map(v => <tr key={v.vehicle_id} data-vehicle-id={v.vehicle_id} className={v.is_mine ? 'em-row-mine' : ''}>
        <th scope="row"><div className="em-resource-id"><span className="em-resource-symbol"><HubIcon name="vehicle" size={19} /></span><div><strong>{v.vehicle_id}</strong><span>{v.type}</span></div></div></th>
        <td><VehicleBattery level={v.battery_level} /></td><td><span className="em-hub-cell">{v.hub_name ?? 'Đang di chuyển'}</span></td>
        <td><span className={'em-badge ' + vehicleStatus[v.state].className}><i />{vehicleStatus[v.state].label}</span></td>
        <td><span className={'em-owner' + (v.is_mine ? ' em-owner-mine' : '')}>{vehicleOwnerLabel(v)}</span></td>
        <td className="em-actions"><div><VehicleActions vehicle={v} pending={pending} hasRental={hasRental} onAction={onAction} /></div></td>
      </tr>)}{!rows.length && <tr><td colSpan={6}><div className="em-empty"><HubIcon name="search" size={30} />
        <strong>{!vehicles.length ? 'Chưa có phương tiện trong phạm vi này' : filter === 'mine' ? 'Chưa có phương tiện của bạn trong phạm vi này' : 'Không tìm thấy phương tiện phù hợp'}</strong>
        <span>Thử đổi Hub, phạm vi, bộ lọc hoặc từ khóa.</span><button type="button" className="em-text-button" onClick={onReset}>Hiển thị tất cả</button>
      </div></td></tr>}</tbody></table>
    </div><div className="em-table-footer" role="status"><span>Hiển thị {rows.length} / {vehicles.length} phương tiện</span><span><HubIcon name="lock" size={13} />Chỉ quản lý phương tiện của bạn</span></div>
  </div>
}
