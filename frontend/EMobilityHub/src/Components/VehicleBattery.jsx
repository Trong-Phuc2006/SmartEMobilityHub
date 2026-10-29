export default function VehicleBattery({ level }) {
  return <div className={'em-battery' + (level < 20 ? ' em-battery-low' : '')} aria-label={`Mức pin ${level}%${level < 20 ? ', pin thấp' : ''}`}>
    <span className="em-battery-track" aria-hidden="true"><i style={{ width: `${level}%` }} /></span>
    <span>{level}%{level < 20 && <small>Pin thấp · cần ≥20%</small>}</span>
  </div>
}
