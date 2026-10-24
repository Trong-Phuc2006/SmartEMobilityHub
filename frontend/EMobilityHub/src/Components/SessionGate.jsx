import AuthLayout from './AuthLayout.jsx'
import { errorMessage } from '../Services/auth-validation.js'

export default function SessionGate({ state, session, onLoggedOut }) {
  const restoring = state.status === 'restoring' || state.logoutPending
  const loggingOut = state.error?.operation === 'logout'
  async function retryLogout() {
    if (await session.logout()) onLoggedOut()
  }
  return (
    <AuthLayout title={restoring ? state.logoutPending ? 'Đang đăng xuất…' : 'Đang kiểm tra phiên đăng nhập…' : loggingOut ? 'Chưa xác nhận được đăng xuất' : 'Chưa thể kiểm tra phiên đăng nhập'}
      description={restoring ? 'Vui lòng chờ trong giây lát.' : 'Bạn có thể thử lại khi kết nối ổn định.'}>
      {restoring ? <p className="session-progress" role="status">Đang kết nối…</p> : (
        <>
          <p className="notice notice-error" role="alert">{errorMessage(state.error?.cause)}</p>
          <div className="session-actions">
            <button type="button" className="button button-primary"
              onClick={loggingOut ? retryLogout : session.restore}>{loggingOut ? 'Thử đăng xuất lại' : 'Thử lại'}</button>
            {loggingOut && <button type="button" className="button button-outline" onClick={session.restore}>Kiểm tra phiên đăng nhập</button>}
          </div>
        </>
      )}
    </AuthLayout>
  )
}
