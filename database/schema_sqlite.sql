-- Smart E-Mobility Hub schema for SQLite
-- UUIDs are stored as TEXT; timestamps should use ISO-8601 TEXT.
-- Enable foreign keys on EVERY connection: PRAGMA foreign_keys = ON;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS "Users" (
  "user_id" TEXT PRIMARY KEY,
  "role" TEXT NOT NULL CHECK ("role" IN ('STUDENT','OPERATOR')),
  "email" TEXT NOT NULL UNIQUE,
  "password_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE'
);

CREATE TABLE IF NOT EXISTS "Hubs" (
  "hub_id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "location_type" TEXT,
  -- Configured maximum capacity; keep it synchronized with ParkingSpaces in application logic.
  "total_parking_capacity" INTEGER NOT NULL CHECK ("total_parking_capacity" >= 0)
);

CREATE TABLE IF NOT EXISTS "Vehicles" (
  "vehicle_id" TEXT PRIMARY KEY,
  "hub_id" TEXT,
  "type" TEXT NOT NULL,
  "battery_level" INTEGER NOT NULL CHECK ("battery_level" BETWEEN 0 AND 100),
  "state" TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK ("state" IN ('AVAILABLE','RESERVED','IN_USE','UNAVAILABLE')),
  FOREIGN KEY ("hub_id") REFERENCES "Hubs"("hub_id"),
  CHECK (("state" = 'IN_USE' AND "hub_id" IS NULL) OR ("state" <> 'IN_USE' AND "hub_id" IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS "PrivateVehicles" (
  "private_vehicle_id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL,
  "plate_number" TEXT NOT NULL UNIQUE,
  FOREIGN KEY ("user_id") REFERENCES "Users"("user_id")
);

CREATE TABLE IF NOT EXISTS "ParkingSpaces" (
  "space_id" TEXT PRIMARY KEY,
  "hub_id" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK ("state" IN ('AVAILABLE','RESERVED','OCCUPIED')),
  FOREIGN KEY ("hub_id") REFERENCES "Hubs"("hub_id")
);

CREATE TABLE IF NOT EXISTS "ChargingPoints" (
  "point_id" TEXT PRIMARY KEY,
  "hub_id" TEXT NOT NULL,
  "power_output" REAL CHECK ("power_output" IS NULL OR "power_output" > 0),
  "state" TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK ("state" IN ('AVAILABLE','RESERVED','CHARGING','UNAVAILABLE')),
  FOREIGN KEY ("hub_id") REFERENCES "Hubs"("hub_id")
);

CREATE TABLE IF NOT EXISTS "Reservations" (
  "reservation_id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL,
  "type" TEXT NOT NULL CHECK ("type" IN ('VEHICLE','PARKING')),
  "vehicle_id" TEXT,
  "space_id" TEXT,
  "start_time" TEXT NOT NULL,
  "end_time" TEXT,
  "state" TEXT NOT NULL DEFAULT 'RESERVED' CHECK ("state" IN ('RESERVED','ACTIVE','COMPLETED','CANCELLED','EXPIRED')),
  "created_at" TEXT NOT NULL,
  FOREIGN KEY ("user_id") REFERENCES "Users"("user_id"),
  FOREIGN KEY ("vehicle_id") REFERENCES "Vehicles"("vehicle_id"),
  FOREIGN KEY ("space_id") REFERENCES "ParkingSpaces"("space_id"),
  CHECK (("type" = 'VEHICLE' AND "vehicle_id" IS NOT NULL AND "space_id" IS NULL) OR ("type" = 'PARKING' AND "space_id" IS NOT NULL AND "vehicle_id" IS NULL)),
  CHECK ("end_time" IS NULL OR "end_time" > "start_time")
);

CREATE TABLE IF NOT EXISTS "ChargingSessions" (
  "session_id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL,
  "hub_id" TEXT NOT NULL,
  "point_id" TEXT,
  "vehicle_id" TEXT,
  "private_vehicle_id" TEXT,
  "priority" TEXT NOT NULL DEFAULT 'NORMAL' CHECK ("priority" IN ('NORMAL','HIGH','URGENT')),
  "target_battery_level" INTEGER CHECK ("target_battery_level" IS NULL OR "target_battery_level" BETWEEN 0 AND 100),
  "start_time" TEXT,
  "end_time" TEXT,
  "state" TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK ("state" IN ('WAITING','SCHEDULED','CHARGING','COMPLETED','CANCELLED','INTERRUPTED')),
  "created_at" TEXT NOT NULL,
  FOREIGN KEY ("user_id") REFERENCES "Users"("user_id"),
  FOREIGN KEY ("hub_id") REFERENCES "Hubs"("hub_id"),
  FOREIGN KEY ("point_id") REFERENCES "ChargingPoints"("point_id"),
  FOREIGN KEY ("vehicle_id") REFERENCES "Vehicles"("vehicle_id"),
  FOREIGN KEY ("private_vehicle_id") REFERENCES "PrivateVehicles"("private_vehicle_id"),
  CHECK (("vehicle_id" IS NOT NULL AND "private_vehicle_id" IS NULL) OR ("vehicle_id" IS NULL AND "private_vehicle_id" IS NOT NULL)),
  CHECK ("end_time" IS NULL OR "start_time" IS NULL OR "end_time" > "start_time"),
  CHECK ("state" <> 'CHARGING' OR "point_id" IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS "Incidents" (
  "incident_id" TEXT PRIMARY KEY,
  "hub_id" TEXT NOT NULL,
  "vehicle_id" TEXT,
  "point_id" TEXT,
  "reported_by" TEXT NOT NULL,
  "description" TEXT,
  "state" TEXT NOT NULL DEFAULT 'OPEN' CHECK ("state" IN ('OPEN','RESOLVED')),
  "reported_at" TEXT NOT NULL,
  "resolved_at" TEXT,
  FOREIGN KEY ("hub_id") REFERENCES "Hubs"("hub_id"),
  FOREIGN KEY ("vehicle_id") REFERENCES "Vehicles"("vehicle_id"),
  FOREIGN KEY ("point_id") REFERENCES "ChargingPoints"("point_id"),
  FOREIGN KEY ("reported_by") REFERENCES "Users"("user_id"),
  CHECK ("resolved_at" IS NULL OR "resolved_at" >= "reported_at"),
  CHECK ("state" <> 'RESOLVED' OR "resolved_at" IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS "VehicleTransfers" (
  "transfer_id" TEXT PRIMARY KEY,
  "vehicle_id" TEXT NOT NULL,
  "from_hub_id" TEXT NOT NULL,
  "to_hub_id" TEXT NOT NULL,
  "created_by" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'PLANNED' CHECK ("state" IN ('PLANNED','DONE','CANCELLED')),
  "created_at" TEXT NOT NULL,
  FOREIGN KEY ("vehicle_id") REFERENCES "Vehicles"("vehicle_id"),
  FOREIGN KEY ("from_hub_id") REFERENCES "Hubs"("hub_id"),
  FOREIGN KEY ("to_hub_id") REFERENCES "Hubs"("hub_id"),
  FOREIGN KEY ("created_by") REFERENCES "Users"("user_id"),
  CHECK ("from_hub_id" <> "to_hub_id")
);

CREATE INDEX IF NOT EXISTS "idx_vehicles_hub_state" ON "Vehicles"("hub_id", "state");
CREATE INDEX IF NOT EXISTS "idx_spaces_hub_state" ON "ParkingSpaces"("hub_id", "state");
CREATE INDEX IF NOT EXISTS "idx_charging_points_hub_state" ON "ChargingPoints"("hub_id", "state");
CREATE INDEX IF NOT EXISTS "idx_reservations_user_state" ON "Reservations"("user_id", "state");
CREATE INDEX IF NOT EXISTS "idx_reservations_vehicle_state" ON "Reservations"("vehicle_id", "state");
CREATE INDEX IF NOT EXISTS "idx_reservations_space_state" ON "Reservations"("space_id", "state");
CREATE INDEX IF NOT EXISTS "idx_charging_sessions_hub_state" ON "ChargingSessions"("hub_id", "state");
CREATE INDEX IF NOT EXISTS "idx_incidents_hub_state" ON "Incidents"("hub_id", "state");
CREATE INDEX IF NOT EXISTS "idx_transfers_vehicle_state" ON "VehicleTransfers"("vehicle_id", "state");
