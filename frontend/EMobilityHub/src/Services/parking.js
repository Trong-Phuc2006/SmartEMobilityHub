import { ApiError } from './http.js'

const states = ['AVAILABLE', 'RESERVED', 'OCCUPIED']
const integer = (value) => Number.isSafeInteger(value) && value >= 0
function hubDto(hub) {
  if (!hub || typeof hub.hub_id !== 'string' || typeof hub.name !== 'string' ||
    !(hub.location_type === null || typeof hub.location_type === 'string') || !integer(hub.total_parking_capacity)) {
    throw new ApiError('UNEXPECTED_RESPONSE', { kind: 'protocol' })
  }
  const { hub_id, name, location_type, total_parking_capacity } = hub
  return { hub_id, name, location_type, total_parking_capacity }
}

export function createParkingApi(http) {
  return {
    async hubs(options) {
      const { data, status } = await http.request('/hubs', options)
      if (status !== 200 || !Array.isArray(data.hubs)) throw new ApiError('UNEXPECTED_RESPONSE')
      return data.hubs.map(hubDto)
    },
    async spaces(hubId, options) {
      const { data, status } = await http.request('/hubs/' + encodeURIComponent(hubId) + '/parking-spaces', options)
      const hub = hubDto(data.hub)
      const summary = data.summary
      if (status !== 200 || hub.hub_id !== hubId || !Array.isArray(data.spaces) || !summary ||
        !['total_spaces', 'available', 'reserved', 'occupied'].every((key) => integer(summary[key])) ||
        summary.total_spaces !== summary.available + summary.reserved + summary.occupied ||
        summary.total_spaces !== data.spaces.length) throw new ApiError('UNEXPECTED_RESPONSE')
      const seen = new Set()
      const counts = { AVAILABLE: 0, RESERVED: 0, OCCUPIED: 0 }
      const spaces = data.spaces.map((row) => {
        if (!row || typeof row.space_id !== 'string' || seen.has(row.space_id) || row.hub_id !== hubId ||
          !states.includes(row.state) || typeof row.has_current_reservation !== 'boolean' || typeof row.is_mine !== 'boolean' ||
          (row.is_mine && !row.has_current_reservation) ||
          (row.state === 'AVAILABLE' && (row.has_current_reservation || row.is_mine))) throw new ApiError('UNEXPECTED_RESPONSE')
        seen.add(row.space_id)
        counts[row.state]++
        const { space_id, hub_id, state, has_current_reservation, is_mine } = row
        return { space_id, hub_id, state, has_current_reservation, is_mine }
      })
      if (states.some((state) => counts[state] !== summary[state.toLowerCase()])) throw new ApiError('UNEXPECTED_RESPONSE')
      return { hub, summary: Object.fromEntries(['total_spaces', 'available', 'reserved', 'occupied'].map((key) => [key, summary[key]])), spaces }
    },
  }
}

export const parkingStatus = {
  AVAILABLE: { label: 'Còn trống', className: 'em-badge-available' },
  RESERVED: { label: 'Đã đặt', className: 'em-badge-reserved' },
  OCCUPIED: { label: 'Đang sử dụng', className: 'em-badge-occupied' },
}

export function ownershipLabel(space) {
  if (space.state === 'AVAILABLE') return '—'
  return space.is_mine ? 'Của bạn' : space.has_current_reservation ? 'Người dùng khác' : 'Chưa có thông tin'
}

export function filterSpaces(spaces, filter, search) {
  const term = search.trim().toLowerCase()
  return spaces.filter((space) => (filter === 'all' || (filter === 'available' ? space.state === 'AVAILABLE' : space.is_mine)) &&
    space.space_id.toLowerCase().includes(term))
}

export function parkingErrorMessage(error) {
  return ({
    HUB_NOT_FOUND: 'Hub này không còn khả dụng. Vui lòng tải lại danh sách Hub.',
    DATA_INTEGRITY_ERROR: 'Dữ liệu bãi đỗ xe chưa nhất quán. Vui lòng thử lại sau.',
    NETWORK_ERROR: 'Không thể kết nối máy chủ. Vui lòng kiểm tra kết nối và thử lại.',
    SERVICE_UNAVAILABLE: 'Dịch vụ tạm thời bận. Vui lòng thử lại.',
  })[error?.code] || 'Chưa thể tải dữ liệu bãi đỗ xe. Vui lòng thử lại.'
}
