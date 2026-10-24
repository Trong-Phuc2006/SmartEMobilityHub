const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  BACKEND_ROOT, DEMO_DATABASE_PATH, TEAM_DATABASE_PATH, SCHEMA_PATH, samePath,
} = require("../src/config/env");

function createWorkspace(t) {
  const base = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(base, "smartemobilityhub-fixture-"));
  t.after(() => {
    assert.ok(samePath(path.dirname(directory), base));
    assert.ok(path.basename(directory).startsWith("smartemobilityhub-fixture-"));
    assert.ok(!fs.lstatSync(directory).isSymbolicLink());
    assert.ok(samePath(fs.realpathSync(directory), directory));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function protectedSnapshot() {
  return [SCHEMA_PATH, TEAM_DATABASE_PATH, DEMO_DATABASE_PATH].map((filename) => ({
    filename,
    hash: fs.existsSync(filename)
      ? crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex")
      : null,
  }));
}

function testEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of [
    "NODE_ENV", "PORT", "HOST", "FRONTEND_ORIGIN", "DATABASE_PATH", "JWT_SECRET", "COOKIE_SECURE",
  ]) delete env[key];
  return {
    ...env, NODE_ENV: "test", PORT: "0", HOST: "127.0.0.1", DATABASE_PATH: ":memory:",
    JWT_SECRET: crypto.randomBytes(32).toString("hex"), ...overrides,
  };
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: BACKEND_ROOT, encoding: "utf8", timeout: 10000, windowsHide: true, env: testEnv(), ...options,
  });
}

module.exports = { createWorkspace, protectedSnapshot, testEnv, runNode };
