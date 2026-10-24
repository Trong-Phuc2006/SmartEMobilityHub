const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { startServer } = require("../src/server");
const { parseConfig, BACKEND_ROOT, TEAM_DATABASE_PATH } = require("../src/config/env");
const { protectedSnapshot, runNode, testEnv } = require("./helpers");

test("app, server and DB modules import without opening SQLite or consuming invalid config", () => {
  const before = protectedSnapshot();
  const result = runNode(["-e", [
    "const p=require.resolve('better-sqlite3');",
    "require.cache[p]={id:p,filename:p,loaded:true,exports:class {constructor(){throw new Error('Unexpected SQLite open')}}};",
    "require('./src/app');require('./src/config/db');require('./src/server');",
  ].join("")], { env: testEnv({ PORT: "invalid", DATABASE_PATH: TEAM_DATABASE_PATH }) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(protectedSnapshot(), before);
});

test("backend startup serves the root envelope and configured CORS, then closes its DB and socket", async () => {
  const before = protectedSnapshot();
  const config = parseConfig(testEnv());
  const running = await startServer({ config });
  try {
    const url = "http://127.0.0.1:" + running.server.address().port;
    const response = await fetch(url, { headers: { Origin: config.frontendOrigin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), config.frontendOrigin);
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    assert.deepEqual(await response.json(), {
      ok: true, data: { message: "Smart E-Mobility Hub API is running" },
    });
    assert.equal(running.db.pragma("foreign_keys", { simple: true }), 1);
    assert.equal((await fetch(url + "/auth/me")).status, 401);
    assert.equal((await fetch(url + "/hubs")).status, 401);
  } finally {
    await running.close();
  }
  await running.close();
  assert.equal(running.db.open, false);
  assert.equal(running.server.listening, false);
  assert.deepEqual(protectedSnapshot(), before);
});

test("port-in-use startup fails and the original isolated server remains usable", async () => {
  const running = await startServer({
    config: parseConfig(testEnv()),
  });
  try {
    const config = parseConfig(testEnv({ PORT: String(running.server.address().port) }));
    await assert.rejects(startServer({ config }), { code: "EADDRINUSE" });
    assert.equal(running.db.open, true);
  } finally {
    await running.close();
  }
});

test("invalid CLI startup exits nonzero before opening any persistent DB", () => {
  const before = protectedSnapshot();
  for (const overrides of [{ PORT: "invalid" }, { DATABASE_PATH: TEAM_DATABASE_PATH }]) {
    const result = runNode(["src/server.js"], { env: testEnv(overrides) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Configuration error:/);
    assert.ok(!result.stdout.includes("Server running"));
  }
  assert.deepEqual(protectedSnapshot(), before);
});

test("real Auth server CLI starts with isolated valid config and an ephemeral test-only JWT secret", { timeout: 10000 }, async (t) => {
  const before = protectedSnapshot();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: BACKEND_ROOT, env: testEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  let output = "";
  let errors = "";
  child.stderr.setEncoding("utf8").on("data", (text) => { errors += text; });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CLI startup timed out")), 5000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("CLI exited before ready: " + errors)); });
    child.stdout.setEncoding("utf8").on("data", (text) => {
      output += text;
      const found = output.match(/Server running on (http:\/\/127\.0\.0\.1:\d+)/);
      if (found) { clearTimeout(timer); resolve(found[1]); }
    });
  });
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  child.kill(); // Windows terminates this owned test child; no team/demo DB is open.
  await exited;
  assert.deepEqual(protectedSnapshot(), before);
});
