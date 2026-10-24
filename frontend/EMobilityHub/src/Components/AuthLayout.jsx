import Brand from './Brand.jsx'

export default function AuthLayout({ title, description, children }) {
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <Brand />
        <header className="auth-heading">
          <h1 id="auth-title">{title}</h1>
          <p>{description}</p>
        </header>
        {children}
      </section>
    </main>
  )
}
