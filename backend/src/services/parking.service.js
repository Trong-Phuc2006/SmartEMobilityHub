const { ApiError } = require("../http/errors");

const HUB_FIELDS = "hub_id,name,location_type,total_parking_capacity";

function listHubs(db) {
  return db.prepare(`SELECT ${HUB_FIELDS} FROM Hubs ORDER BY name,hub_id`).all();
}

function readParking(db, hubId, userId) {
  if (typeof hubId !== "string" || [...hubId].length < 1 || [...hubId].length > 128 || /\p{Cc}/u.test(hubId)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Mã Hub chưa hợp lệ.", { hubId: "INVALID_HUB_ID" });
  }
  // A deferred transaction pins the snapshot at the first SELECT. No writes,
  // expiration or repairs, including when an error rolls this transaction back.
  return db.transaction(() => {
    const hub = db.prepare(`SELECT ${HUB_FIELDS} FROM Hubs WHERE hub_id=?`).get(hubId);
    if (!hub) throw new ApiError(404, "HUB_NOT_FOUND", "Không tìm thấy Mobility Hub.");
    // Aggregate before projection: each space contributes exactly one row.
    const rows = db.prepare(`
      SELECT p.space_id,p.hub_id,p.state,COUNT(r.space_id) AS matches,
             MAX(CASE WHEN r.user_id=? THEN 1 ELSE 0 END) AS mine
      FROM ParkingSpaces p
      LEFT JOIN Reservations r ON r.space_id=p.space_id AND r.type='PARKING'
        AND ((p.state='RESERVED' AND r.state='RESERVED')
          OR (p.state='OCCUPIED' AND r.state='ACTIVE'))
      WHERE p.hub_id=?
      GROUP BY p.space_id,p.hub_id,p.state ORDER BY p.space_id
    `).all(userId, hubId);
    const summary = { total_spaces: rows.length, available: 0, reserved: 0, occupied: 0 };
    const spaces = rows.map(({ space_id, hub_id, state, matches, mine }) => {
      if (matches > 1 || !["AVAILABLE", "RESERVED", "OCCUPIED"].includes(state)) {
        throw new ApiError(500, "DATA_INTEGRITY_ERROR", "Dữ liệu bãi đỗ xe chưa nhất quán.");
      }
      summary[state.toLowerCase()]++;
      return { space_id, hub_id, state, has_current_reservation: matches === 1, is_mine: mine === 1 };
    });
    return { hub, summary, spaces };
  }).deferred();
}

module.exports = { listHubs, readParking };
