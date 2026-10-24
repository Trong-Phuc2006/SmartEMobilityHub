const paths = {
  overview: [],
  parking: ['M10 17V7h3a3 3 0 0 1 0 6h-3'],
  vehicle: ['m5 17 5-9 5 9H5M8 8h4m3-3h3l1 12m-9-9h6'],
  charging: ['m13 2-9 12h7l-1 8L20 9h-7V2Z'],
  location: ['M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z'],
  down: ['m6 9 6 6 6-6'],
  arrow: ['M5 12h14m-5-5 5 5-5 5'],
  search: ['m16 16 4.5 4.5'],
  lock: ['M8 10V7a4 4 0 0 1 8 0v3'],
  check: ['m5 12 4 4L19 6'],
  info: ['M12 11v6m0-10v.1'],
}

export default function HubIcon({ name, size = 20 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'overview' && [[3, 3], [14, 3], [3, 14], [14, 14]].map(([x, y]) => <rect key={x + '-' + y} x={x} y={y} width="7" height="7" rx="1.5" />)}
    {name === 'parking' && <rect x="4" y="3" width="16" height="18" rx="3" />}
    {name === 'vehicle' && <><circle cx="5" cy="17" r="3" /><circle cx="19" cy="17" r="3" /></>}
    {name === 'location' && <circle cx="12" cy="10" r="2" />}
    {name === 'search' && <circle cx="10.5" cy="10.5" r="6.5" />}
    {name === 'lock' && <rect x="5" y="10" width="14" height="11" rx="2" />}
    {name === 'info' && <circle cx="12" cy="12" r="9" />}
    {(paths[name] || paths.info).map((d) => <path key={d} d={d} />)}
  </svg>
}
