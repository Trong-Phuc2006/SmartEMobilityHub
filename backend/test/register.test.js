const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Database = require("better-sqlite3");
const { createApp } = require("../src/app");
const { createTestDatabase } = require("../src/config/db");
const { parseConfig, TEAM_DATABASE_PATH, DEMO_DATABASE_PATH } = require("../src/config/env");
const { verifyPassword } = require("../src/services/password.service");
const { protectedSnapshot, testEnv } = require("./helpers");

const valid = { email: "student@example.com", password: "fixture-password" };

async function fixture(t) {
  const before = protectedSnapshot();
  const resource = createTestDatabase();
  const { db, filename } = resource;
  assert.notEqual(filename, TEAM_DATABASE_PATH);
  assert.notEqual(filename, DEMO_DATABASE_PATH);
  assert.equal(path.dirname(path.dirname(filename)), fs.realpathSync(os.tmpdir()));
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n, 10);
  const config = parseConfig(testEnv());
  const server = http.createServer(createApp({ config, db }));
  t.after(async () => {
    try {
      if (server.listening) await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    } finally {
      resource.cleanup();
      assert.equal(fs.existsSync(path.dirname(filename)), false);
      assert.deepEqual(protectedSnapshot(), before);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = "http://127.0.0.1:" + server.address().port;
  async function post(body = valid, options = {}) {
    const headers = { Origin: config.frontendOrigin, "Content-Type": "application/json", ...options.headers };
    for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
    const response = await fetch(base + "/auth/register", {
      method: "POST", headers,
      body: Object.hasOwn(options, "raw") ? options.raw : JSON.stringify(body),
    });
    const json = await response.json();
    assert.match(response.headers.get("content-type"), /application\/json; charset=utf-8/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("set-cookie"), null);
    return { response, json };
  }
  return { ...resource, post, base, config };
}

function expectError(result, status, code, fields = {}) {
  assert.equal(result.response.status, status);
  assert.deepEqual(Object.keys(result.json).sort(), ["error", "ok"]);
  assert.equal(result.json.ok, false);
  assert.deepEqual(Object.keys(result.json.error).sort(), ["code", "fieldErrors", "message"]);
  assert.equal(result.json.error.code, code);
  assert.deepEqual(result.json.error.fieldErrors, fields);
  assert.equal(typeof result.json.error.message, "string");
  assert.ok(result.json.error.message.length > 0);
  assert.doesNotMatch(JSON.stringify(result.json), /password_hash|scrypt\$|SQLITE_|INSERT INTO|stack|fixture-password/);
}

test("register creates exactly one persistent STUDENT ACTIVE, a UUID and a real scrypt hash without a cookie", async (t) => {
  const { db, filename, post, config } = await fixture(t);
  const { response, json } = await post({ email: "  Student@Example.COM  ", password: valid.password });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("access-control-allow-origin"), config.frontendOrigin);
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
  assert.deepEqual(Object.keys(json).sort(), ["data", "ok"]);
  assert.equal(json.ok, true);
  assert.deepEqual(Object.keys(json.data), ["user"]);
  const user = json.data.user;
  assert.deepEqual(Object.keys(user).sort(), ["email", "role", "user_id"]);
  assert.match(user.user_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(user.email, valid.email);
  assert.equal(user.role, "STUDENT");
  const rows = db.prepare("SELECT * FROM Users").all();
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0], password_hash: undefined }, { ...user, status: "ACTIVE", password_hash: undefined });
  assert.notEqual(rows[0].password_hash, valid.password);
  assert.equal(await verifyPassword(valid.password, rows[0].password_hash), true);
  assert.equal(await verifyPassword("incorrect-password", rows[0].password_hash), false);
  assert.doesNotMatch(JSON.stringify(json), /password|hash|status|token/i);
  db.close();
  const reopened = new Database(filename, { fileMustExist: true });
  try {
    reopened.pragma("foreign_keys = ON");
    assert.equal(reopened.pragma("foreign_keys", { simple: true }), 1);
    assert.deepEqual(reopened.prepare("SELECT * FROM Users").all(), rows);
  } finally {
    reopened.close();
  }
});

test("validation rejects invalid/missing/types/lengths/extra fields before writing", async (t) => {
  const { db, post } = await fixture(t);
  const cases = [
    ["missing email", { password: valid.password }, { email: "REQUIRED" }],
    ["missing password", { email: valid.email }, { password: "REQUIRED" }],
    ["missing both", {}, { email: "REQUIRED", password: "REQUIRED" }],
    ["malformed email", { ...valid, email: "no-at-sign" }, { email: "INVALID_EMAIL" }],
    ["empty email", { ...valid, email: "   " }, { email: "INVALID_EMAIL" }],
    ["email whitespace", { ...valid, email: "a b@example.com" }, { email: "INVALID_EMAIL" }],
    ["long email", { ...valid, email: "x".repeat(243) + "@example.com" }, { email: "INVALID_EMAIL" }],
    ["numeric email", { ...valid, email: 123 }, { email: "INVALID_TYPE" }],
    ["null email", { ...valid, email: null }, { email: "INVALID_TYPE" }],
    ["array email", { ...valid, email: [] }, { email: "INVALID_TYPE" }],
    ["numeric password", { ...valid, password: 12345678 }, { password: "INVALID_TYPE" }],
    ["null password", { ...valid, password: null }, { password: "INVALID_TYPE" }],
    ["object password", { ...valid, password: {} }, { password: "INVALID_TYPE" }],
    ["short password", { ...valid, password: "x".repeat(7) }, { password: "PASSWORD_LENGTH" }],
    ["long password", { ...valid, password: "x".repeat(129) }, { password: "PASSWORD_LENGTH" }],
    ["short unicode", { ...valid, password: "🔋".repeat(7) }, { password: "PASSWORD_LENGTH" }],
    ["long unicode", { ...valid, password: "🔋".repeat(129) }, { password: "PASSWORD_LENGTH" }],
    ["role escalation", { ...valid, role: "OPERATOR" }, { role: "UNEXPECTED_FIELD" }],
    ["status override", { ...valid, status: "ACTIVE" }, { status: "UNEXPECTED_FIELD" }],
    ["user ID override", { ...valid, user_id: "client" }, { user_id: "UNEXPECTED_FIELD" }],
    ["confirmation", { ...valid, confirmPassword: valid.password }, { confirmPassword: "UNEXPECTED_FIELD" }],
    ["unknown field", { ...valid, extra: true }, { extra: "UNEXPECTED_FIELD" }],
    ["array body", [], { _body: "INVALID_TYPE" }],
    ["null body", null, { _body: "INVALID_TYPE" }],
    ["string body", "example", { _body: "INVALID_TYPE" }],
    ["number body", 1, { _body: "INVALID_TYPE" }],
  ];
  for (const [name, body, fields] of cases) {
    await t.test(name, async () => expectError(await post(body), 400, "VALIDATION_ERROR", fields));
  }
  const proto = await post(valid, {
    raw: '{"email":"student@example.com","password":"fixture-password","__proto__":{}}',
  });
  expectError(proto, 400, "VALIDATION_ERROR", JSON.parse('{"__proto__":"UNEXPECTED_FIELD"}'));
  assert.equal({}.polluted, undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM Users").get().n, 0);
});

test("JSON/media type/size and Origin failures use safe stable envelopes and never write", async (t) => {
  const { db, post } = await fixture(t);
  for (const origin of [undefined, "null", "http://evil.example", "http://localhost:5173/", "http://localhost:5174"]) {
    expectError(await post(valid, { headers: { Origin: origin } }), 403, "ORIGIN_NOT_ALLOWED");
  }
  // Origin is checked before parsing; no bypass via invalid JSON or wrong media type.
  expectError(await post(valid, { headers: { Origin: undefined }, raw: "{" }), 403, "ORIGIN_NOT_ALLOWED");
  for (const type of [undefined, "text/plain", "application/x-www-form-urlencoded", "application/json-patch+json"]) {
    expectError(await post(valid, { headers: { "Content-Type": type } }), 415, "UNSUPPORTED_MEDIA_TYPE");
  }
  expectError(await post(valid, { raw: "{" }), 400, "INVALID_JSON");
  expectError(await post(valid, { raw: "" }), 400, "VALIDATION_ERROR", { email: "REQUIRED", password: "REQUIRED" });
  expectError(await post(valid, { headers: { "Content-Type": "application/json; charset=iso-8859-1" } }),
    415, "UNSUPPORTED_MEDIA_TYPE");
  expectError(await post(valid, { raw: JSON.stringify({ ...valid, password: "x".repeat(8192) }) }),
    413, "PAYLOAD_TOO_LARGE");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM Users").get().n, 0);
});

test("duplicate normalization and concurrent attempts do not insert a second user", async (t) => {
  const { db, post } = await fixture(t);
  assert.equal((await post()).response.status, 201);
  for (const email of [valid.email, " STUDENT@EXAMPLE.COM "]) {
    expectError(await post({ ...valid, email }), 409, "EMAIL_EXISTS", { email: "EMAIL_EXISTS" });
  }
  const results = await Promise.all([
    post({ ...valid, email: "race@example.com" }),
    post({ ...valid, email: "RACE@EXAMPLE.COM" }),
  ]);
  assert.deepEqual(results.map((r) => r.response.status).sort(), [201, 409]);
  expectError(results.find((r) => r.response.status === 409), 409, "EMAIL_EXISTS", { email: "EMAIL_EXISTS" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM Users").get().n, 2);
});

test("existing Unicode/mixed-case emails are compared without changing existing users", async (t) => {
  const { db, post } = await fixture(t);
  db.prepare("INSERT INTO Users (user_id,role,email,password_hash,status) VALUES (?,?,?,?,?)")
    .run("existing", "OPERATOR", "ĐẶNG@EXAMPLE.COM", "intentionally-malformed-fixture", "INACTIVE");
  const before = db.prepare("SELECT * FROM Users").all();
  expectError(await post({ ...valid, email: " đặng@example.com " }), 409, "EMAIL_EXISTS", { email: "EMAIL_EXISTS" });
  assert.deepEqual(db.prepare("SELECT * FROM Users").all(), before);
});

test("UTF-8 email and Unicode password boundaries are accepted and preserved", async (t) => {
  const { db, post } = await fixture(t);
  for (const [index, password] of ["🔋".repeat(8), "🔋".repeat(128), "  Demo🔋e\u0301  "].entries()) {
    const result = await post({ email: " SinhViên" + index + "@Example.COM ", password });
    assert.equal(result.response.status, 201);
    assert.equal(result.json.data.user.email, "sinhviên" + index + "@example.com");
    const row = db.prepare("SELECT password_hash FROM Users WHERE user_id=?").get(result.json.data.user.user_id);
    assert.equal(await verifyPassword(password, row.password_hash), true);
  }
  const boundary = "x".repeat(242) + "@example.com";
  assert.equal(boundary.length, 254);
  assert.equal((await post({ ...valid, email: boundary })).response.status, 201);
});

test("database UNIQUE conflicts, busy locks and unexpected SQL failures never leak internal details", async (t) => {
  const { db, filename, post } = await fixture(t);
  // Exercise the constraint fallback separately from the case-insensitive precheck.
  db.exec(`CREATE TRIGGER test_unique BEFORE INSERT ON Users BEGIN
    INSERT INTO Users (user_id,role,email,password_hash,status)
    VALUES ('constraint-fixture','STUDENT',NEW.email,'intentionally-malformed-fixture','ACTIVE');
  END`);
  expectError(await post(), 409, "EMAIL_EXISTS", { email: "EMAIL_EXISTS" });
  db.exec("DROP TRIGGER test_unique");
  const blocker = new Database(filename, { fileMustExist: true });
  db.pragma("busy_timeout = 1");
  try {
    blocker.exec("BEGIN IMMEDIATE");
    expectError(await post(), 503, "SERVICE_UNAVAILABLE");
  } finally {
    if (blocker.inTransaction) blocker.exec("ROLLBACK");
    blocker.close();
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM Users").get().n, 0);
  db.exec("CREATE TRIGGER test_failure BEFORE INSERT ON Users BEGIN SELECT RAISE(ABORT, 'private database detail'); END");
  expectError(await post(), 500, "INTERNAL_ERROR");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM Users").get().n, 0);
  db.exec("DROP TRIGGER test_failure");
  // The transaction/connection remains usable after each failure.
  assert.equal((await post()).response.status, 201);
});

test("preflight, unsupported Auth GET methods and protected Parking retain protocol/JSON semantics", async (t) => {
  const { base, config, db } = await fixture(t);
  const preflight = await fetch(base + "/auth/register", {
    method: "OPTIONS", headers: {
      Origin: config.frontendOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(await preflight.text(), "");
  assert.equal(preflight.headers.get("access-control-allow-origin"), config.frontendOrigin);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
  for (const route of ["/auth/login", "/auth/logout"]) {
    const response = await fetch(base + route);
    expectError({ response, json: await response.json() }, 404, "NOT_FOUND");
  }
  const me = await fetch(base + "/auth/me");
  expectError({ response: me, json: await me.json() }, 401, "AUTH_REQUIRED");
  const hubs = await fetch(base + "/hubs");
  expectError({ response: hubs, json: await hubs.json() }, 401, "AUTH_REQUIRED");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM Users").get().n, 0);
});
