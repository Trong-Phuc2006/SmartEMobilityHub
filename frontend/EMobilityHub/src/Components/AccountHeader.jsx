import Brand from './Brand.jsx'

export default function AccountHeader({ user, pending, onLogout, dashboard = false, children }) {
  const initials = [...user.email.split('@')[0]].slice(0, 2).join('').toUpperCase()
  return (
    <header className={'account-header' + (dashboard ? ' em-header' : '')}>
      {dashboard ? <div className="em-header-title">Smart E-Mobility Hub<span>Bảng điều khiển sinh viên</span></div> : <Brand />}
      <div className={'account-controls' + (dashboard ? ' em-header-right' : '')}>
        {children}
        <div className="account" aria-label={'Tài khoản: ' + user.email}>
          <span className="avatar" aria-hidden="true">{initials}</span>
          <div className="account-text"><strong title={user.email}>{user.email}</strong><span>Sinh viên</span></div>
        </div>
        <button type="button" className="button button-outline" onClick={onLogout} disabled={pending}>
          {pending ? 'Đang đăng xuất…' : 'Đăng xuất'}
        </button>
      </div>
    </header>
  )
}
