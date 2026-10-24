const assert = require("node:assert/strict");
const { createTestDatabase } = require("./db");

function runDatabaseSmoke() {
  const resource = createTestDatabase();
  try {
    const { db } = resource;
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    db.prepare("INSERT INTO Hubs (hub_id, name, total_parking_capacity) VALUES (?, ?, ?)").run("smoke-hub", "Isolated smoke hub", 1);
    db.prepare("INSERT INTO ParkingSpaces (space_id, hub_id) VALUES (?, ?)").run("smoke-space", "smoke-hub");
    assert.equal(db.prepare("SELECT state FROM ParkingSpaces WHERE space_id=?").get("smoke-space").state, "AVAILABLE");
    assert.throws(
      () => db.prepare("INSERT INTO ParkingSpaces (space_id, hub_id) VALUES (?, ?)").run("invalid-space", "missing-hub"),
      { code: "SQLITE_CONSTRAINT_FOREIGNKEY" },
    );
  } finally {
    resource.cleanup();
  }
}

if (require.main === module) {
  try {
    runDatabaseSmoke();
    console.log("Isolated SQLite smoke PASS; connection closed and temporary files removed.");
  } catch {
    console.error("Isolated SQLite smoke FAIL.");
    process.exitCode = 1;
  }
}
module.exports = { runDatabaseSmoke };
