import AccountHeader from '../Components/AccountHeader.jsx'

export default function ProtectedPlaceholder({ user, route, pending, onLogout }) {
  return (
    <div className="protected-page" data-protected-view>
      <AccountHeader user={user} pending={pending} onLogout={onLogout} />
      <main className="placeholder-main">
        <section className="placeholder-card">
          <span className="placeholder-label">Chưa triển khai</span>
          <h1>{route === '#/overview' ? 'Tổng quan đang được triển khai' : 'Bãi đỗ xe đang được triển khai'}</h1>
          <p>{route === '#/overview' ? 'Thông tin tổng quan chưa khả dụng.' : 'Thông tin bãi đỗ xe chưa khả dụng.'}</p>
        </section>
      </main>
    </div>
  )
}
