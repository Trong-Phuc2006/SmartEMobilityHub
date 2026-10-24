const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { PROJECT_ROOT } = require("../src/config/env");

test("Git protects secrets/generated files while keeping examples, schema, sources and docs trackable", () => {
  const ignored = [
    "backend/node_modules/probe.js", "frontend/EMobilityHub/node_modules/probe.js",
    "backend/.env", "frontend/EMobilityHub/.env.local",
    "backend/probe.key", "backend/probe.pem", "backend/coverage/probe.txt",
    "database/smart_mobility.demo.db", "database/probe.db-wal", "database/probe.db-shm",
    "database/probe.sqlite-journal", "database/probe.sqlite3-shm",
    "backend/.tmp/probe.txt", "backend/result.tmp", "frontend/EMobilityHub/dist/probe.js",
  ];
  const trackable = [
    ".env.example", "backend/.env.example", "frontend/EMobilityHub/.env.example",
    "backend/package.json", "backend/package-lock.json", "database/schema_sqlite.sql",
    "backend/src/config/env.js", "backend/test/database.test.js", "README.md",
    "frontend/EMobilityHub/src/App.jsx", "frontend/EMobilityHub/vite.config.js",
    "frontend/EMobilityHub/package.json", "frontend/EMobilityHub/package-lock.json",
  ];
  for (const [paths, expected] of [[ignored, 0], [trackable, 1]]) {
    for (const filename of paths) {
      const result = spawnSync("git", ["-c", "core.excludesFile=", "check-ignore", "--no-index", "--quiet", "--", filename], {
        cwd: PROJECT_ROOT, encoding: "utf8", timeout: 5000, windowsHide: true,
      });
      assert.equal(result.status, expected, filename + ": " + result.stderr);
    }
  }
});
