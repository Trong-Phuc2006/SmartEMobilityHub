import HubIcon from './HubIcon.jsx'
import { navigate } from '../Services/navigation.js'

export default function ParkingSummary({ summary, vehicleSummary, overview, pending, activeModule = 'parking' }) {
  const counts = [summary && { available: summary.available, total: summary.total_spaces },
    vehicleSummary && { available: vehicleSummary.available, total: vehicleSummary.total_vehicles }, null]
  return <div className="em-cards">
    {['parking', 'vehicle', 'charging'].map((module, index) => <button type="button" key={module}
      disabled={index === 2 || pending} onClick={() => navigate(index === 0 ? '#/parking' : '#/vehicle')}
      className={'em-summary' + (!overview && module === activeModule ? ' em-summary-active' : '')}
      aria-label={index === 0 ? 'Xem bãi đỗ xe' : index === 1 ? 'Xem thuê phương tiện' : undefined}>
      <div className="em-summary-top"><span>{['Chỗ đỗ xe khả dụng', 'Phương tiện khả dụng', 'Trạm sạc khả dụng'][index]}</span>
        <span className="em-summary-icon"><HubIcon name={module} /></span></div>
      <div className="em-summary-count">{counts[index] ? String(counts[index].available).padStart(2, '0') : '—'}
        {counts[index] && <span>/ {counts[index].total}</span>}</div>
      <div className="em-summary-bottom"><span>{index === 0 ? 'Xem chỗ đỗ xe' : index === 1 ? 'Xem phương tiện' : 'Chưa triển khai'}</span>
        {index < 2 && <HubIcon name="arrow" size={17} />}</div>
    </button>)}
  </div>
}
