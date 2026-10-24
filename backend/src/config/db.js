const Database = require("better-sqlite3");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DEMO_DATABASE_PATH, SCHEMA_PATH, samePath } = require("./env");

const TEST_PREFIX = "smartemobilityhub-test-";

function initializeDatabase(filename) {
  const db = new Database(filename);
  try {
    db.pragma("foreign_keys = ON");
    db.transaction(() => db.exec(fs.readFileSync(SCHEMA_PATH, "utf8")))();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function openDemoDatabase(filename) {
  if (typeof filename !== "string" || !path.isAbsolute(filename) || !samePath(filename, DEMO_DATABASE_PATH)) {
    throw new Error("Refusing to open a database outside the approved demo location.");
  }
  const parent = path.dirname(DEMO_DATABASE_PATH);
  if (!samePath(fs.realpathSync(parent), parent)) {
    throw new Error("Refusing a demo database directory redirected through a link.");
  }
  if (fs.existsSync(DEMO_DATABASE_PATH)) {
    const stat = fs.lstatSync(DEMO_DATABASE_PATH);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
      throw new Error("Refusing a linked or non-file demo database.");
    }
  }
  // Never reset, delete or seed an existing database.
  return initializeDatabase(DEMO_DATABASE_PATH);
}

function createTestDatabase({ memory = false } = {}) {
  const tempBase = fs.realpathSync(os.tmpdir());
  const directory = memory ? null : fs.mkdtempSync(path.join(tempBase, TEST_PREFIX));
  const filename = memory ? ":memory:" : path.join(directory, "test.sqlite");
  let db;

  function cleanup() {
    if (db?.open) db.close();
    if (!directory || !fs.existsSync(directory)) return;
    const resolved = path.resolve(directory);
    // Only the exact directory this call created may be removed. No env/caller path.
    if (
      !samePath(path.dirname(resolved), tempBase) ||
      !path.basename(resolved).startsWith(TEST_PREFIX) ||
      fs.lstatSync(resolved).isSymbolicLink() ||
      !samePath(fs.realpathSync(resolved), resolved)
    ) {
      throw new Error("Refusing cleanup outside the owned temporary database directory.");
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }

  try {
    db = initializeDatabase(filename);
    return Object.freeze({ db, filename, cleanup });
  } catch (error) {
    cleanup();
    throw error;
  }
}

// Importing this module does not open any connection.
module.exports = { openDemoDatabase, createTestDatabase };
