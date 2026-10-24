const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  parseConfig, loadConfig, ConfigError, BACKEND_ROOT, DEMO_DATABASE_PATH, TEAM_DATABASE_PATH,
} = require("../src/config/env");
const { createWorkspace, runNode } = require("./helpers");

test("pure configuration defaults match local settings; JWT is optional before the Auth startup gate", () => {
  const config = parseConfig({});
  assert.equal(config.port, 3000);
  assert.equal(config.host, "localhost");
  assert.equal(config.frontendOrigin, "http://localhost:5173");
  assert.equal(config.databasePath, DEMO_DATABASE_PATH);
  assert.equal(config.jwtSecret, undefined);
  assert.equal(Object.isFrozen(config), true);
});

test("environment file loading is explicit and existing environment values take precedence", (t) => {
  const directory = createWorkspace(t);
  const envFile = path.join(directory, ".env");
  fs.writeFileSync(envFile, "PORT=4100\nFRONTEND_ORIGIN=http://localhost:5173\n", "utf8");
  assert.equal(loadConfig({ env: {}, envFile }).port, 4100);
  assert.equal(loadConfig({ env: { PORT: "4200" }, envFile }).port, 4200);
});

test("relative DATABASE_PATH resolves against backend, not the process working directory", (t) => {
  const directory = createWorkspace(t);
  const envModule = path.join(BACKEND_ROOT, "src/config/env.js");
  const result = runNode(["-e",
    "const c=require(process.argv[1]).parseConfig({DATABASE_PATH:'../database/smart_mobility.demo.db'});process.stdout.write(c.databasePath)",
    envModule,
  ], { cwd: directory });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, DEMO_DATABASE_PATH);
});

test("invalid ports, host, origin, node environment and JWT values fail clearly without echoing input", () => {
  for (const env of [
    { PORT: "" }, { PORT: "-1" }, { PORT: "3000abc" }, { PORT: "65536" }, { PORT: "0" },
    { HOST: "0.0.0.0" }, { NODE_ENV: "invalid" },
    { FRONTEND_ORIGIN: "*" }, { FRONTEND_ORIGIN: "http://localhost:5173/" },
    { FRONTEND_ORIGIN: "https://user:private@localhost" },
    { JWT_SECRET: "invalid-private-value" },
  ]) {
    assert.throws(() => parseConfig(env), ConfigError);
  }
  assert.throws(() => parseConfig({ JWT_SECRET: "invalid-private-value" }), (error) => {
    assert.ok(!error.message.includes("invalid-private-value"));
    return true;
  });
});

test("test config rejects persistent demo/team paths; isolated config/DB checks need no JWT", () => {
  for (const databasePath of [TEAM_DATABASE_PATH, DEMO_DATABASE_PATH, "test.sqlite"]) {
    assert.throws(() => parseConfig({ NODE_ENV: "test", DATABASE_PATH: databasePath }), /Test startup requires/);
  }
  const config = loadConfig({ env: { NODE_ENV: "test", PORT: "0" } });
  assert.equal(config.databasePath, ":memory:");
  assert.equal(config.jwtSecret, undefined);
  assert.equal(parseConfig({ JWT_SECRET: "ab".repeat(32) }).jwtSecret.length, 64);
});

test("development cannot be redirected to a team or arbitrary database", () => {
  for (const databasePath of [TEAM_DATABASE_PATH, "unrelated.sqlite", ":memory:", ""]) {
    assert.throws(() => parseConfig({ DATABASE_PATH: databasePath }), ConfigError);
  }
});
