export default function Brand({ dashboard = false }) {
  return (
    <div className="brand" aria-label="e-mobility — Hub sinh viên">
      <span className="brand-mark" aria-hidden="true">
        <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d={dashboard ? 'm13 2-9 12h7l-1 8L20 9h-7V2Z' : 'm13 2-3 8H5l6 12 3-8h5L13 2Z'} />
        </svg>
      </span>
      <div>e-mobility<span>HUB SINH VIÊN</span></div>
    </div>
  )
}
