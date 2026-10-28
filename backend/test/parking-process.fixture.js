// Test-only process: accepts a path exclusively allocated by createTestDatabase.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { startServer } = require("../src/server");
const { parseConfig } = require("../src/config/env");
process.once("message", async ({ filename, secret }) => {
  const resolved = fs.realpathSync(filename);
  if (path.dirname(path.dirname(resolved)) !== fs.realpathSync(os.tmpdir()) ||
    !path.basename(path.dirname(resolved)).startsWith("smartemobilityhub-test-") || path.basename(resolved) !== "test.sqlite") throw new Error("Unowned test database");
  const db = new Database(resolved, { fileMustExist: true });
  db.pragma("foreign_keys=ON");
  const config = parseConfig({ NODE_ENV: "test", PORT: "0", HOST: "localhost", FRONTEND_ORIGIN: "http://localhost:5173", JWT_SECRET: secret });
  const running = await startServer({ config, createDatabase: () => ({ db, cleanup: () => db.close() }) });
  const stop = async () => { await running.close(); if (process.connected) process.disconnect(); };
  process.once("disconnect", () => { void running.close(); });
  process.on("message", (message) => { if (message === "shutdown") void stop(); });
  process.send({ ready: true, port: running.server.address().port });
});
