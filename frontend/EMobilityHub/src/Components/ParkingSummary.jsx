import HubIcon from './HubIcon.jsx'
import { navigate } from '../Services/navigation.js'

export default function ParkingSummary({ summary, overview, pending }) {
  return <div className="em-cards">
    {['parking', 'vehicle', 'charging'].map((module, index) => <button type="button" key={module}
      disabled={index !== 0 || pending} onClick={() => navigate('#/parking')}
      className={'em-summary' + (!overview && index === 0 ? ' em-summary-active' : '')}
      aria-label={index === 0 ? 'Xem bãi đỗ xe' : undefined}>
      <div className="em-summary-top"><span>{['Chỗ đỗ xe khả dụng', 'Phương tiện khả dụng', 'Trạm sạc khả dụng'][index]}</span>
        <span className="em-summary-icon"><HubIcon name={module} /></span></div>
      <div className="em-summary-count">{index === 0 && summary ? String(summary.available).padStart(2, '0') : '—'}
        {index === 0 && summary && <span>/ {summary.total_spaces}</span>}</div>
      <div className="em-summary-bottom"><span>{index === 0 ? 'Xem chỗ đỗ xe' : 'Chưa triển khai'}</span>
        {index === 0 && <HubIcon name="arrow" size={17} />}</div>
    </button>)}
  </div>
}
