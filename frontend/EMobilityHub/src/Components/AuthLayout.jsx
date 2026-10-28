import Brand from './Brand.jsx'
import campusScene from '../assets/mobility-campus.svg'

export default function AuthLayout({ title, description, children }) {
  return (
    <main className="auth-page">
      <aside className="auth-hero" aria-label="Smart E-Mobility Hub — kết nối hành trình xanh">
        <div className="auth-hero-top"><span className="auth-campus-label"><i /> SMART CAMPUS · CONNECTED MOBILITY</span><span className="auth-hero-number">01 / HÀNH TRÌNH XANH</span></div>
        <div className="auth-hero-copy"><p className="auth-eyebrow">DI CHUYỂN THÔNG MINH. SỐNG XANH HƠN.</p>
          <h2>Một điểm kết nối.<br /><span>Muôn hành trình xanh.</span></h2>
          <p>Chỗ đỗ, phương tiện điện và trạm sạc trong một hệ sinh thái di chuyển dành cho sinh viên.</p></div>
        <img className="auth-scene" src={campusScene} alt="Minh họa khuôn viên đại học với ô tô điện, xe đạp, bãi đỗ và trạm sạc kết nối" />
        <div className="auth-hero-bottom"><span><b>01</b> Tìm chỗ đỗ</span><span><b>02</b> Đặt &amp; đến bãi</span><span><b>03</b> Sẵn sàng di chuyển</span></div>
      </aside>
      <div className="auth-panel">
      <section className="auth-card" aria-labelledby="auth-title">
        <Brand />
        <p className="auth-product-name">Smart E-Mobility Hub</p>
        <header className="auth-heading">
          <h1 id="auth-title">{title}</h1>
          <p>{description}</p>
        </header>
        {children}
      </section>
      <p className="auth-panel-note">Kết nối khuôn viên · Đồng hành cùng sinh viên</p>
      </div>
    </main>
  )
}
