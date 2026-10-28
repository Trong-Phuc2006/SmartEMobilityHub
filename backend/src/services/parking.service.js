const { ApiError } = require("../http/errors");

const HUB_FIELDS = "hub_id,name,location_type,total_parking_capacity";
const { randomUUID } = require("node:crypto");

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

function validateId(value, field) {
  if (typeof value !== "string" || [...value].length < 1 || [...value].length > 128 || /\p{Cc}/u.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Mã tài nguyên chưa hợp lệ.", { [field]: field === "hubId" ? "INVALID_HUB_ID" : "INVALID_SPACE_ID" });
  }
}
function integrity() { throw new ApiError(500, "DATA_INTEGRITY_ERROR", "Dữ liệu bãi đỗ xe chưa nhất quán."); }

function ownReservations(db, userId) {
  return db.transaction(() => {
    const rows = db.prepare(`SELECT r.space_id,r.state AS reservation_state,p.state,p.hub_id,h.name AS hub_name,
      (SELECT COUNT(*) FROM Reservations x WHERE x.space_id=r.space_id AND x.type='PARKING'
       AND x.state IN ('RESERVED','ACTIVE')) AS matches
      FROM Reservations r LEFT JOIN ParkingSpaces p ON p.space_id=r.space_id LEFT JOIN Hubs h ON h.hub_id=p.hub_id
      WHERE r.user_id=? AND r.type='PARKING' AND r.state IN ('RESERVED','ACTIVE') ORDER BY p.hub_id,r.space_id`).all(userId);
    return rows.map(({ space_id, state, reservation_state, hub_id, hub_name, matches }) => {
      if (typeof hub_id !== "string" || typeof hub_name !== "string" || matches !== 1 || (reservation_state === "RESERVED" ? state !== "RESERVED" : state !== "OCCUPIED")) integrity();
      return { space_id, hub_id, hub_name, state };
    });
  }).deferred();
}

function mutateParking(db, { hubId, spaceId, userId, action }) {
  validateId(hubId, "hubId"); validateId(spaceId, "spaceId");
  if (!["reserve", "arrive", "release"].includes(action)) throw new TypeError("Unknown Parking operation.");
  return db.transaction(() => {
    const user = db.prepare("SELECT role,status FROM Users WHERE user_id=?").get(userId);
    if (!user) throw new ApiError(401, "SESSION_INVALID", "Phiên đăng nhập không hợp lệ.");
    if (user.status !== "ACTIVE") throw new ApiError(403, "ACCOUNT_DISABLED", "Tài khoản không khả dụng.");
    if (user.role !== "STUDENT") throw new ApiError(403, "ROLE_NOT_SUPPORTED", "Vai trò chưa được hỗ trợ.");
    if (!db.prepare("SELECT 1 FROM Hubs WHERE hub_id=?").get(hubId)) throw new ApiError(404, "HUB_NOT_FOUND", "Không tìm thấy Mobility Hub.");
    const space = db.prepare("SELECT state FROM ParkingSpaces WHERE space_id=? AND hub_id=?").get(spaceId, hubId);
    if (!space) throw new ApiError(404, "SPACE_NOT_FOUND", "Không tìm thấy chỗ đỗ xe.");
    const reservations = db.prepare("SELECT * FROM Reservations WHERE space_id=? AND type='PARKING' AND state IN ('RESERVED','ACTIVE')").all(spaceId);
    const reservation = reservations[0];
    if (reservations.length > 1 || (reservation && (reservation.state === "RESERVED" ? space.state !== "RESERVED" : space.state !== "OCCUPIED"))) integrity();
    const now = new Date().toISOString();
    let next;
    if (action === "reserve") {
      if (space.state !== "AVAILABLE") throw new ApiError(409, "SPACE_UNAVAILABLE", "Chỗ đỗ không còn trống.");
      if (db.prepare("SELECT 1 FROM Reservations WHERE user_id=? AND type='PARKING' AND state IN ('RESERVED','ACTIVE') LIMIT 1").get(userId)) {
        throw new ApiError(409, "ACTIVE_RESERVATION_EXISTS", "Bạn đang giữ một chỗ đỗ. Hãy trả chỗ trước khi đặt mới.");
      }
      next = "RESERVED";
      db.prepare(`INSERT INTO Reservations(reservation_id,user_id,type,space_id,start_time,state,created_at)
        VALUES (?,?,'PARKING',?,?,'RESERVED',?)`).run(randomUUID(), userId, spaceId, now, now);
    } else {
      if (!reservation || !["RESERVED", "OCCUPIED"].includes(space.state)) throw new ApiError(409, "INVALID_PARKING_TRANSITION", "Trạng thái không cho phép thao tác này.");
      if (reservation.user_id !== userId) throw new ApiError(403, "PARKING_NOT_OWNED", "Bạn chỉ có thể quản lý chỗ đỗ của mình.");
      if (action === "arrive" && space.state !== "RESERVED") throw new ApiError(409, "INVALID_PARKING_TRANSITION", "Chỗ đỗ đã được sử dụng.");
      next = action === "arrive" ? "OCCUPIED" : "AVAILABLE";
      const state = action === "arrive" ? "ACTIVE" : space.state === "RESERVED" ? "CANCELLED" : "COMPLETED";
      const start = Date.parse(reservation.start_time);
      if (!Number.isFinite(start)) integrity();
      // A whole second also orders after legacy ISO strings without fractions,
      // because SQLite's existing CHECK compares timestamp TEXT lexically.
      const end = action === "arrive" ? null : new Date(Math.max(Date.now(), start + 1000)).toISOString();
      if (db.prepare("UPDATE Reservations SET state=?,end_time=? WHERE reservation_id=? AND user_id=? AND state=?")
        .run(state, end, reservation.reservation_id, userId, reservation.state).changes !== 1) integrity();
    }
    if (db.prepare("UPDATE ParkingSpaces SET state=? WHERE space_id=? AND hub_id=? AND state=?").run(next, spaceId, hubId, space.state).changes !== 1) integrity();
    // Response snapshot stays under the same lock; a failure rolls back both writes.
    return { parking: readParking(db, hubId, userId), reservations: ownReservations(db, userId) };
  }).immediate();
}

module.exports = { listHubs, readParking, ownReservations, mutateParking };
