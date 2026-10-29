import Brand from './Brand.jsx'
import AccountHeader from './AccountHeader.jsx'
import HubIcon from './HubIcon.jsx'
import { navigate } from '../Services/navigation.js'

export default function AppShell({ user, route, pending, onLogout, hubs, selectedHub, hubsLoading, onHubChange, children }) {
  const items = [
    ['overview', 'Tổng quan', '#/overview'], ['parking', 'Bãi đỗ xe', '#/parking'],
    ['vehicle', 'Thuê phương tiện', '#/vehicle'], ['charging', 'Trạm sạc'],
  ]
  const activeRoute = route.startsWith('#/overview') ? '#/overview' : route
  return <div className="em" data-protected-view>
    <aside className="em-sidebar">
      <Brand dashboard />
      <div className="em-nav-label">ĐIỀU HƯỚNG</div>
      <nav aria-label="Điều hướng Mobility Hub">
        {items.map(([icon, label, hash]) => <button type="button" key={icon} disabled={!hash || pending}
          className={'em-nav-item' + (activeRoute === hash ? ' em-nav-active' : '')}
          aria-current={activeRoute === hash ? 'page' : undefined} onClick={() => navigate(hash)}>
          <HubIcon name={icon} /><span>{label}{!hash && <small>Chưa triển khai</small>}</span>
          {activeRoute === hash && <span className="em-nav-dot" />}
        </button>)}
      </nav>
      <div className="em-sidebar-bottom"><div className="em-demo-label">Đồ án Công nghệ phần mềm<span>DỮ LIỆU DEMO · SQLITE</span></div></div>
    </aside>
    <div className="em-workspace">
      <AccountHeader user={user} pending={pending} onLogout={onLogout} dashboard>
        <div className="em-hub-control">
          <span className="em-hub-label">Hub hiện tại</span>
          <label className="em-hub-select"><HubIcon name="location" size={18} />
            <select aria-label="Chọn Mobility Hub" value={selectedHub} disabled={hubsLoading || !hubs.length || pending}
              onChange={(event) => onHubChange(event.target.value)}>
              {!hubs.length && <option value="">{hubsLoading ? 'Đang tải Hub…' : 'Chưa có Hub'}</option>}
              {hubs.map((hub) => <option key={hub.hub_id} value={hub.hub_id}>{hub.name}</option>)}
            </select><HubIcon name="down" size={15} />
          </label>
        </div>
      </AccountHeader>
      {children}
    </div>
  </div>
}
