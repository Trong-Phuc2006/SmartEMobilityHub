const { randomUUID } = require("node:crypto");
const { ApiError } = require("../http/errors");
const { sessionUser } = require("./auth.service");

const STATES = ["AVAILABLE", "RESERVED", "IN_USE", "UNAVAILABLE"];
function integrity() {
  throw new ApiError(500, "DATA_INTEGRITY_ERROR", "Dữ liệu phương tiện chưa nhất quán.");
}
function validateId(value, field) {
  if (typeof value !== "string" || [...value].length < 1 || [...value].length > 128 || /\p{Cc}/u.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Mã tài nguyên chưa hợp lệ.", {
      [field]: field === "vehicleId" ? "INVALID_VEHICLE_ID" : "INVALID_HUB_ID",
    });
  }
}
function validateReturn(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Dữ liệu chưa hợp lệ.", { _body: "INVALID_TYPE" });
  }
  const fields = Object.fromEntries(Object.keys(body).filter(k => !["hub_id", "battery_level"].includes(k)).map(k => [k, "UNEXPECTED_FIELD"]));
  for (const key of ["hub_id", "battery_level"]) if (!Object.hasOwn(body, key)) fields[key] = "REQUIRED";
  if (Object.hasOwn(body, "hub_id")) {
    try { validateId(body.hub_id, "hub_id"); } catch { fields.hub_id = "INVALID_HUB_ID"; }
  }
  if (Object.hasOwn(body, "battery_level")) {
    if (typeof body.battery_level !== "number") fields.battery_level = "INVALID_TYPE";
    else if (!Number.isInteger(body.battery_level) || body.battery_level < 0 || body.battery_level > 100) fields.battery_level = "INVALID_BATTERY_LEVEL";
  }
  if (Object.keys(fields).length) throw new ApiError(400, "VALIDATION_ERROR", "Dữ liệu chưa hợp lệ.", fields);
  return { hub_id: body.hub_id, battery_level: body.battery_level };
}

// Called only inside a read/write transaction. Reading the fleet and current
// reservations separately avoids join multiplication and detects orphan rows.
// Terminal history is deliberately excluded, never repaired or deleted.
function snapshot(db, userId) {
  const vehicles = db.prepare(`SELECT v.vehicle_id,v.type,v.battery_level,v.state,v.hub_id,h.name AS hub_name
    FROM Vehicles v LEFT JOIN Hubs h ON h.hub_id=v.hub_id ORDER BY v.vehicle_id`).all();
  const byId = new Map(vehicles.map(v => [v.vehicle_id, v]));
  const current = new Map();
  for (const r of db.prepare(`SELECT r.*,u.role AS owner_role FROM Reservations r
    LEFT JOIN Users u ON u.user_id=r.user_id
    WHERE r.type='VEHICLE' AND r.state IN ('RESERVED','ACTIVE') ORDER BY r.vehicle_id`).all()) {
    if (!byId.has(r.vehicle_id) || current.has(r.vehicle_id) || r.owner_role !== "STUDENT" ||
      typeof r.user_id !== "string" || !r.user_id || r.space_id !== null || r.end_time !== null ||
      !Number.isFinite(Date.parse(r.start_time)) || !Number.isFinite(Date.parse(r.created_at))) integrity();
    current.set(r.vehicle_id, r);
  }
  const rows = vehicles.map(v => {
    const r = current.get(v.vehicle_id);
    if (typeof v.vehicle_id !== "string" || !v.vehicle_id || typeof v.type !== "string" ||
      !Number.isInteger(v.battery_level) || v.battery_level < 0 || v.battery_level > 100 || !STATES.includes(v.state) ||
      (v.state === "IN_USE" ? v.hub_id !== null || v.hub_name !== null : typeof v.hub_id !== "string" || typeof v.hub_name !== "string") ||
      (v.state === "RESERVED" ? r?.state !== "RESERVED" : v.state === "IN_USE" ? r?.state !== "ACTIVE" : Boolean(r))) integrity();
    return { ...v, has_current_reservation: Boolean(r), is_mine: r?.user_id === userId };
  });
  const reservations = rows.filter(v => v.is_mine).map(v => ({ ...v, reservation_state: current.get(v.vehicle_id).state }));
  return { rows, current, reservations };
}
function summary(rows) {
  const result = { total_vehicles: rows.length, available: 0, reserved: 0, in_use: 0, unavailable: 0 };
  for (const row of rows) result[row.state.toLowerCase()]++;
  return result;
}
function readVehicles(db, userId, hubId) {
  if (hubId !== undefined) validateId(hubId, "hub_id");
  return db.transaction(() => {
    if (hubId !== undefined && !db.prepare("SELECT 1 FROM Hubs WHERE hub_id=?").get(hubId)) {
      throw new ApiError(404, "HUB_NOT_FOUND", "Không tìm thấy Mobility Hub.");
    }
    const { rows } = snapshot(db, userId);
    const vehicles = hubId === undefined ? rows : rows.filter(v => v.hub_id === hubId);
    return { vehicles, summary: summary(vehicles) };
  }).deferred();
}
function ownVehicleReservations(db, userId) {
  return db.transaction(() => snapshot(db, userId).reservations).deferred();
}
function mutateVehicle(db, { vehicleId, userId, action, body }) {
  validateId(vehicleId, "vehicleId");
  if (!["reserve", "pickup", "return", "cancel"].includes(action)) throw new TypeError("Unknown Vehicle operation.");
  const returned = action === "return" ? validateReturn(body) : null;
  return db.transaction(() => {
    sessionUser(db, userId); // Recheck current account after acquiring the write lock.
    const before = snapshot(db, userId);
    const vehicle = before.rows.find(v => v.vehicle_id === vehicleId);
    if (!vehicle) throw new ApiError(404, "VEHICLE_NOT_FOUND", "Không tìm thấy phương tiện.");
    const reservation = before.current.get(vehicleId);
    const now = new Date().toISOString();
    let state, hub = vehicle.hub_id, battery = vehicle.battery_level;
    if (action === "reserve") {
      if (vehicle.state !== "AVAILABLE") throw new ApiError(409, "VEHICLE_UNAVAILABLE", "Phương tiện không còn khả dụng.");
      if (battery < 20) throw new ApiError(409, "BATTERY_TOO_LOW", "Pin dưới 20%, chưa thể đặt xe.");
      if (before.reservations.length) throw new ApiError(409, "ACTIVE_VEHICLE_RESERVATION_EXISTS", "Bạn đang giữ một phương tiện. Hãy kết thúc lượt thuê trước.");
      db.prepare(`INSERT INTO Reservations(reservation_id,user_id,type,vehicle_id,space_id,start_time,end_time,state,created_at)
        VALUES (?,?,'VEHICLE',?,NULL,?,NULL,'RESERVED',?)`).run(randomUUID(), userId, vehicleId, now, now);
      state = "RESERVED";
    } else {
      if (!reservation) throw new ApiError(409, "INVALID_VEHICLE_TRANSITION", "Trạng thái không cho phép thao tác này.");
      if (reservation.user_id !== userId) throw new ApiError(403, "VEHICLE_NOT_OWNED", "Bạn chỉ có thể quản lý phương tiện của mình.");
      if ((action === "return" ? vehicle.state !== "IN_USE" : vehicle.state !== "RESERVED")) {
        throw new ApiError(409, "INVALID_VEHICLE_TRANSITION", "Trạng thái đã thay đổi. Hãy tải lại.");
      }
      if (returned) {
        if (!db.prepare("SELECT 1 FROM Hubs WHERE hub_id=?").get(returned.hub_id)) throw new ApiError(404, "HUB_NOT_FOUND", "Không tìm thấy Mobility Hub.");
        hub = returned.hub_id; battery = returned.battery_level;
      }
      state = action === "pickup" ? "IN_USE" : "AVAILABLE";
      if (action === "pickup") hub = null;
      const next = action === "pickup" ? "ACTIVE" : action === "cancel" ? "CANCELLED" : "COMPLETED";
      // One full second orders after legacy timestamps without fractions too.
      const end = action === "pickup" ? null : new Date(Math.max(Date.now(), Date.parse(reservation.start_time) + 1000)).toISOString();
      if (db.prepare(`UPDATE Reservations SET state=?,end_time=? WHERE reservation_id=? AND user_id=?
        AND type='VEHICLE' AND state=?`).run(next, end, reservation.reservation_id, userId, reservation.state).changes !== 1) integrity();
    }
    if (db.prepare(`UPDATE Vehicles SET state=?,hub_id=?,battery_level=? WHERE vehicle_id=? AND state=?`)
      .run(state, hub, battery, vehicleId, vehicle.state).changes !== 1) integrity();
    const after = snapshot(db, userId); // Snapshot failure rolls back every write.
    return { vehicle: after.rows.find(v => v.vehicle_id === vehicleId), reservations: after.reservations };
  }).immediate();
}
module.exports = { readVehicles, ownVehicleReservations, mutateVehicle, validateId };
