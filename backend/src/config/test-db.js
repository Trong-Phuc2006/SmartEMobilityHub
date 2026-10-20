
const db = require("./db");

function expectFailure(label, action) {
  try {
    action();
    console.error(`❌ FAIL: ${label} was accepted`);
  } catch (error) {
    console.log(`✅ PASS: ${label} was rejected`);
  }
}

try {
  // Keep test records temporary.
  db.exec("SAVEPOINT test_db");

  const now = new Date().toISOString();

  // 1. Insert a valid student.
  db.prepare(`
    INSERT INTO Users
      (user_id, role, email, password_hash)
    VALUES (?, ?, ?, ?)
  `).run("test-user-1", "STUDENT", "test@example.com", "test-hash");

  // 2. Insert a valid hub.
  db.prepare(`
    INSERT INTO Hubs
      (hub_id, name, location_type, total_parking_capacity)
    VALUES (?, ?, ?, ?)
  `).run("test-hub-1", "Demo Hub", "Campus", 10);

  // 3. Insert a valid vehicle.
  db.prepare(`
    INSERT INTO Vehicles
      (vehicle_id, hub_id, type, battery_level)
    VALUES (?, ?, ?, ?)
  `).run("test-vehicle-1", "test-hub-1", "E-BIKE", 80);

  console.log("✅ PASS: Valid records inserted");

  // 4. Verify that the vehicle can be retrieved.
  const vehicle = db.prepare(`
    SELECT v.vehicle_id, v.battery_level, v.state, h.name AS hub_name
    FROM Vehicles v
    JOIN Hubs h ON h.hub_id = v.hub_id
    WHERE v.vehicle_id = ?
  `).get("test-vehicle-1");

  console.log("Vehicle query result:", vehicle);

  // 5. An invalid battery level must be rejected.
  expectFailure("Battery level above 100", () => {
    db.prepare(`
      INSERT INTO Vehicles
        (vehicle_id, hub_id, type, battery_level)
      VALUES (?, ?, ?, ?)
    `).run("test-vehicle-2", "test-hub-1", "E-BIKE", 150);
  });

  // 6. A reference to a nonexistent hub must be rejected.
  expectFailure("Nonexistent hub foreign key", () => {
    db.prepare(`
      INSERT INTO Vehicles
        (vehicle_id, hub_id, type, battery_level)
      VALUES (?, ?, ?, ?)
    `).run("test-vehicle-3", "missing-hub", "E-BIKE", 50);
  });

  // 7. A vehicle reservation must reference a vehicle,
  // not a parking space.
  expectFailure("Reservation with missing vehicle", () => {
    db.prepare(`
      INSERT INTO Reservations
        (reservation_id, user_id, type, vehicle_id, space_id,
         start_time, end_time, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "test-reservation-1",
      "test-user-1",
      "VEHICLE",
      null,
      null,
      now,
      null,
      now
    );
  });

} catch (error) {
  console.error("❌ Unexpected test error:", error.message);
} finally {
  // Remove all test records, including any valid ones.
  db.exec("ROLLBACK TO test_db");
  db.exec("RELEASE test_db");
  console.log("🧹 Test records rolled back; database unchanged.");
  db.close();
}
