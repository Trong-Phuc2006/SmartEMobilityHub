// Fixtures only: callers must supply an isolated test DB with the real schema.
function seedParking(db, userId) {
  const otherId = "other-parking-user";
  db.prepare("INSERT INTO Users(user_id,role,email,password_hash) VALUES (?,?,?,?)")
    .run(otherId, "STUDENT", "private-other@example.com", "not-a-login-fixture");
  const hubs = [
    ["hub-b", "Beta Hub", null, 1], ["hub-a2", "Alpha Hub", null, 0],
    ["hub-a", "Alpha Hub", "CAMPUS", 12], ["hub-empty", "Empty Hub", "DORM", 0],
    ["hub/special ?", "Special Hub", null, 1],
  ];
  const hub = db.prepare("INSERT INTO Hubs(hub_id,name,location_type,total_parking_capacity) VALUES (?,?,?,?)");
  for (const row of hubs) hub.run(...row);
  const spaces = [
    ["A-available", "AVAILABLE"], ["B-reserved-mine", "RESERVED"], ["C-occupied-mine", "OCCUPIED"],
    ["D-reserved-other", "RESERVED"], ["E-occupied-other", "OCCUPIED"],
    ["F-reserved-unknown", "RESERVED"], ["00000000-0000-4000-8000-000000000001-long-occupied-unknown", "OCCUPIED"],
  ];
  const space = db.prepare("INSERT INTO ParkingSpaces(space_id,hub_id,state) VALUES (?,?,?)");
  for (const [id, state] of spaces) space.run(id, "hub-a", state);
  space.run("Beta-space", "hub-b", "AVAILABLE");
  space.run("Special-space", "hub/special ?", "AVAILABLE");
  let sequence = 0;
  function reservation(spaceId, state, owner = userId) {
    db.prepare("INSERT INTO Reservations(reservation_id,user_id,type,space_id,start_time,state,created_at) VALUES (?,?,?,?,?,?,?)")
      .run("parking-fixture-" + (++sequence), owner, "PARKING", spaceId, "2026-10-01T00:00:00Z", state, "2026-10-01T00:00:00Z");
  }
  reservation("B-reserved-mine", "RESERVED");
  reservation("C-occupied-mine", "ACTIVE");
  reservation("D-reserved-other", "RESERVED", otherId);
  reservation("E-occupied-other", "ACTIVE", otherId);
  // History/wrong states must not multiply counts or create ownership.
  for (const state of ["COMPLETED", "CANCELLED", "EXPIRED", "ACTIVE"]) reservation("B-reserved-mine", state, otherId);
  reservation("F-reserved-unknown", "ACTIVE");
  reservation("A-available", "RESERVED");
  return { otherId, reservation, spaces };
}

module.exports = { seedParking };
