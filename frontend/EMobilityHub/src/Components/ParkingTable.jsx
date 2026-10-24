import HubIcon from './HubIcon.jsx'
import { filterSpaces, ownershipLabel, parkingStatus } from '../Services/parking.js'

export default function ParkingTable({ spaces, filter, search, onFilter, onSearch, onReset }) {
  const rows = filterSpaces(spaces, filter, search)
  return <div className="em-table-card">
    <div className="em-table-toolbar">
      <div className="em-filters" role="group" aria-label="Lọc tài nguyên">
        {[['all', 'Tất cả'], ['available', 'Còn trống'], ['mine', 'Của tôi']].map(([id, label]) =>
          <button key={id} type="button" aria-pressed={filter === id} onClick={() => onFilter(id)}
            className={filter === id ? 'em-filter-active' : ''}>{label}{id === 'all' && <span>{spaces.length}</span>}</button>)}
      </div>
      <label className="em-search"><HubIcon name="search" size={17} />
        <input name="parkingSearch" type="search" aria-label="Tìm mã chỗ đỗ" placeholder="Tìm mã chỗ đỗ…"
          value={search} onChange={(event) => onSearch(event.target.value)} />
      </label>
    </div>
    <div className="em-table-scroll" role="region" aria-label="Danh sách chỗ đỗ xe" tabIndex={0}>
      <table><caption className="em-sr-only">Chỗ đỗ xe trong Hub hiện tại</caption>
        <thead><tr>{['Mã chỗ đỗ', 'Trạng thái', 'Người sử dụng', 'Thao tác'].map((name, index) =>
          <th key={name} scope="col" className={index === 3 ? 'em-actions-heading' : undefined}>{name}</th>)}</tr></thead>
        <tbody>{rows.map((space) => <tr key={space.space_id} className={space.is_mine ? 'em-row-mine' : ''}>
          <th scope="row"><div className="em-resource-id"><span className="em-resource-symbol"><HubIcon name="parking" size={18} /></span>
            <strong title={space.space_id}>{space.space_id}</strong></div></th>
          <td><span className={'em-badge ' + parkingStatus[space.state].className}><i />{parkingStatus[space.state].label}</span></td>
          <td><span className={'em-owner' + (space.is_mine ? ' em-owner-mine' : '')}>{space.is_mine && <HubIcon name="check" size={14} />}{ownershipLabel(space)}</span></td>
          <td className="em-actions"><div><span className="em-disabled-action"><HubIcon name="lock" size={13} />Chưa triển khai</span></div></td>
        </tr>)}
          {!rows.length && <tr><td colSpan={4}><div className="em-empty">
            <HubIcon name="search" size={30} /><strong>{spaces.length ? 'Không tìm thấy chỗ đỗ phù hợp' : 'Hub này chưa có chỗ đỗ xe'}</strong>
            <span>{spaces.length ? 'Thử đổi bộ lọc hoặc từ khóa tìm kiếm.' : 'Chọn Mobility Hub khác để xem dữ liệu.'}</span>
            {spaces.length > 0 && <button className="em-text-button" type="button" onClick={onReset}>Hiển thị tất cả</button>}
          </div></td></tr>}
        </tbody>
      </table>
    </div>
    <div className="em-table-footer" role="status"><span>Hiển thị {rows.length} / {spaces.length} chỗ đỗ</span><span><HubIcon name="lock" size={13} />Chỉ xem thông tin</span></div>
  </div>
}
