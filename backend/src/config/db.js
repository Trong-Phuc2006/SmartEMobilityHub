const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const databaseDir = path.resolve(__dirname, "../../../database");

// Create the database directory if it doesn't exist.
if (!fs.existsSync(databaseDir)) {
  fs.mkdirSync(databaseDir, { recursive: true });
}

// Connect to the SQLite database.
const db = new Database(
  path.join(databaseDir, "smart_mobility.db")
);

// Enable foreign-key constraints.
db.pragma("foreign_keys = ON");

try {
  const result = db.prepare("SELECT 1 AS connected").get();
  console.log("✅ Database connected successfully:", result);
} catch (error) {
  console.error("❌ Database connection failed:", error.message);
  throw error;
}

// Read and execute the schema.
const schemaPath = path.join(databaseDir, "schema_sqlite.sql");
const schema = fs.readFileSync(schemaPath, "utf8");

db.exec(schema);

const tables = db.prepare(`
  SELECT name
  FROM sqlite_master
  WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%'
`).all();

console.log("Tables created:", tables);



module.exports = db;
