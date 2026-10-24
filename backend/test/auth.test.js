const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const jwt = require("jsonwebtoken");
const { setAuthCookie, clearAuthCookie } = require("../src/http/auth-cookie");
const {
  authFixture, credentials, cookiePair, expectError, expectClear, AuthCookieJar,
} = require("./auth.helpers");

test("Login issues the approved HttpOnly cookie and public DTO without any Users write", async (t) => {
  const f = await authFixture(t);
  const registered = await f.register();
  const before = f.users();
  const changes = f.changes();
  const result = await f.login({ ...credentials, email: " STUDENT@EXAMPLE.COM " });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.json, { ok: true, data: { user: registered.json.data.user } });
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  const header = result.response.headers.get("set-cookie");
  assert.ok(header.startsWith("semh_auth="));
  for (const attribute of ["; HttpOnly", "; Path=/", "; SameSite=Lax", "; Max-Age=3600"]) {
    assert.ok(header.includes(attribute));
  }
  assert.equal(/; Secure(?:;|$)/.test(header), false);
  assert.equal(/; Domain=/i.test(header), false);
  const expiry = header.match(/; Expires=([^;]+)/);
  assert.ok(expiry && Math.abs(Date.parse(expiry[1]) - Date.now() - 3600000) < 2000);
  const pair = cookiePair(result);
  const value = decodeURIComponent(pair.slice("semh_auth=".length));
  const verified = jwt.verify(value, Buffer.from(f.config.jwtSecret, "hex"), {
    algorithms: ["HS256"], issuer: "smartemobilityhub-api", audience: "smartemobilityhub-web",
  });
  assert.equal(verified.sub, registered.json.data.user.user_id);
  assert.equal(verified.exp - verified.iat, 3600);
  assert.deepEqual(Object.keys(verified).sort(), ["aud", "exp", "iat", "iss", "sub"]);
  assert.doesNotMatch(JSON.stringify(result.json), /password|hash|status|token|eyJ/i);
  assert.equal(result.response.headers.get("access-control-allow-origin"), f.config.frontendOrigin);
  assert.equal(result.response.headers.get("access-control-allow-credentials"), "true");
  assert.deepEqual(f.users(), before);
  assert.equal(f.changes(), changes);
});

test("unknown email and wrong password use the same generic credentials error", async (t) => {
  const f = await authFixture(t);
  await f.register();
  const unknown = await f.login({ ...credentials, email: "unknown@example.com" });
  const wrong = await f.login({ ...credentials, password: "wrong-password" });
  expectError(unknown, 401, "INVALID_CREDENTIALS");
  expectError(wrong, 401, "INVALID_CREDENTIALS");
  assert.deepEqual(unknown.json, wrong.json);
  for (const response of [unknown, wrong]) assert.equal(response.response.headers.get("set-cookie"), null);
  // Login accepts 1..128 code points; short but non-empty is credentials failure.
  expectError(await f.login({ ...credentials, password: "x" }), 401, "INVALID_CREDENTIALS");
  assert.equal(f.users().length, 1);
});

test("Login reuses field codes and exact field validation from P2", async (t) => {
  const f = await authFixture(t);
  const cases = [
    ["missing email", { password: credentials.password }, { email: "REQUIRED" }],
    ["missing password", { email: credentials.email }, { password: "REQUIRED" }],
    ["empty", {}, { email: "REQUIRED", password: "REQUIRED" }],
    ["email type", { ...credentials, email: {} }, { email: "INVALID_TYPE" }],
    ["password type", { ...credentials, password: [] }, { password: "INVALID_TYPE" }],
    ["null password", { ...credentials, password: null }, { password: "INVALID_TYPE" }],
    ["invalid email", { ...credentials, email: "bad-address" }, { email: "INVALID_EMAIL" }],
    ["long email", { ...credentials, email: "x".repeat(255) + "@example.com" }, { email: "INVALID_EMAIL" }],
    ["empty password", { ...credentials, password: "" }, { password: "PASSWORD_LENGTH" }],
    ["long password", { ...credentials, password: "🔋".repeat(129) }, { password: "PASSWORD_LENGTH" }],
    ["role", { ...credentials, role: "STUDENT" }, { role: "UNEXPECTED_FIELD" }],
    ["identity", { ...credentials, user_id: "client" }, { user_id: "UNEXPECTED_FIELD" }],
    ["unknown", { ...credentials, extra: true }, { extra: "UNEXPECTED_FIELD" }],
    ["null body", null, { _body: "INVALID_TYPE" }],
    ["array body", [], { _body: "INVALID_TYPE" }],
    ["string body", "body", { _body: "INVALID_TYPE" }],
  ];
  for (const [name, body, fields] of cases) {
    await t.test(name, async () => {
      const result = await f.login(body);
      expectError(result, 400, "VALIDATION_ERROR", fields);
      assert.equal(result.response.headers.get("set-cookie"), null);
    });
  }
  assert.equal(f.users().length, 0);
});

test("Login checks status/role only after correct password and handles corrupt storage safely", async (t) => {
  const f = await authFixture(t);
  const registered = await f.register();
  const id = registered.json.data.user.user_id;
  f.db.prepare("UPDATE Users SET status=? WHERE user_id=?").run("INACTIVE", id);
  expectError(await f.login({ ...credentials, password: "wrong-password" }), 401, "INVALID_CREDENTIALS");
  const disabled = await f.login();
  expectError(disabled, 403, "ACCOUNT_DISABLED");
  assert.equal(disabled.response.headers.get("set-cookie"), null);
  f.db.prepare("UPDATE Users SET status=?,role=? WHERE user_id=?").run("ACTIVE", "OPERATOR", id);
  expectError(await f.login({ ...credentials, password: "wrong-password" }), 401, "INVALID_CREDENTIALS");
  const operator = await f.login();
  expectError(operator, 403, "ROLE_NOT_SUPPORTED");
  assert.equal(operator.response.headers.get("set-cookie"), null);
  f.db.prepare("UPDATE Users SET password_hash=? WHERE user_id=?").run("malformed-fixture-record", id);
  const malformed = await f.login();
  expectError(malformed, 500, "INTERNAL_ERROR");
  assert.equal(malformed.response.headers.get("set-cookie"), null);
});

test("Login supports P2 Unicode normalization and exact untrimmed Unicode passwords", async (t) => {
  const f = await authFixture(t);
  const password = "  Demo🔋e\u0301  ";
  await f.register({ email: " ĐẶNG@example.com ", password });
  const result = await f.login({ email: "đặng@EXAMPLE.COM", password });
  assert.equal(result.response.status, 200);
  assert.equal(result.json.data.user.email, "đặng@example.com");
  expectError(await f.login({ email: "đặng@example.com", password: password.trim() }), 401, "INVALID_CREDENTIALS");
  expectError(await f.login({ email: "đặng@example.com", password: password.normalize("NFC") }), 401, "INVALID_CREDENTIALS");
  const boundary = { email: "long@example.com", password: "🔋".repeat(128) };
  await f.register(boundary);
  assert.equal((await f.login(boundary)).response.status, 200);
});

test("Me restores current user from cookie, ignores client identity/role and never renews or writes", async (t) => {
  const f = await authFixture(t);
  const registered = await f.register();
  const pair = cookiePair(await f.login());
  const changes = f.changes();
  const before = f.users();
  f.db.pragma("query_only = ON");
  const result = await f.me(pair);
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.json, { ok: true, data: { user: registered.json.data.user } });
  assert.equal(result.response.headers.get("set-cookie"), null);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(JSON.stringify(result.json), /password|hash|status|token|eyJ/i);
  const forgedClaims = f.token({ sub: registered.json.data.user.user_id, role: "OPERATOR", user_id: "other" });
  assert.equal((await f.me("semh_auth=" + forgedClaims)).json.data.user.role, "STUDENT");
  // GET does not require Origin; CORS still permits only configured frontend.
  assert.equal((await f.me(pair, { headers: { Origin: undefined } })).response.status, 200);
  assert.equal(f.changes(), changes);
  assert.deepEqual(f.users(), before);
});

test("Me maps missing, invalid, expired and wrong-signature cookies, and clears rejected sessions", async (t) => {
  const f = await authFixture(t);
  const registered = await f.register();
  const id = registered.json.data.user.user_id;
  const iat = Math.floor(Date.now() / 1000) - 3601;
  const expired = f.token({ sub: id, iat, exp: iat + 3600 });
  const cases = [
    ["missing", undefined, "AUTH_REQUIRED"],
    ["unrelated cookie", "other=value", "AUTH_REQUIRED"],
    ["empty", "semh_auth=", "SESSION_INVALID"],
    ["malformed", "semh_auth=bad", "SESSION_INVALID"],
    ["invalid encoding", "semh_auth=%ZZ", "SESSION_INVALID"],
    ["JSON-looking", "semh_auth=j:%7B%7D", "SESSION_INVALID"],
    ["expired", "semh_auth=" + expired, "SESSION_EXPIRED"],
    ["wrong issuer", "semh_auth=" + f.token({ sub: id, iss: "wrong" }), "SESSION_INVALID"],
    ["wrong audience", "semh_auth=" + f.token({ sub: id, aud: "wrong" }), "SESSION_INVALID"],
    ["HS384", "semh_auth=" + f.token({ sub: id }, { algorithm: "HS384" }), "SESSION_INVALID"],
    ["deleted user", "semh_auth=" + f.token({ sub: "absent-id" }), "SESSION_INVALID"],
  ];
  const valid = cookiePair(await f.login());
  const value = valid.slice("semh_auth=".length);
  const parts = value.split(".");
  parts[1] = Buffer.from('{"sub":"tampered"}').toString("base64url");
  cases.push(["tampered", "semh_auth=" + parts.join("."), "SESSION_INVALID"]);
  for (const [name, cookie, code] of cases) {
    await t.test(name, async () => {
      const result = await f.me(cookie);
      expectError(result, 401, code);
      expectClear(result);
    });
  }
  const wrong = await authFixture(t);
  const otherKeyToken = wrong.token({ sub: id });
  const rejected = await f.me("semh_auth=" + otherKeyToken);
  expectError(rejected, 401, "SESSION_INVALID");
  expectClear(rejected);
});

test("Me rechecks deletion/current status/role in SQLite on every protected request", async (t) => {
  for (const [name, statement, args, status, code] of [
    ["disabled", "UPDATE Users SET status=? WHERE user_id=?", ["INACTIVE"], 403, "ACCOUNT_DISABLED"],
    ["operator", "UPDATE Users SET role=? WHERE user_id=?", ["OPERATOR"], 403, "ROLE_NOT_SUPPORTED"],
    ["deleted", "DELETE FROM Users WHERE user_id=?", [], 401, "SESSION_INVALID"],
  ]) {
    await t.test(name, async (t) => {
      const f = await authFixture(t);
      const registered = await f.register();
      const pair = cookiePair(await f.login());
      f.db.prepare(statement).run(...args, registered.json.data.user.user_id);
      const changes = f.changes();
      const result = await f.me(pair);
      expectError(result, status, code);
      expectClear(result);
      assert.equal(f.changes(), changes);
    });
  }
});

test("transient busy/internal DB errors preserve session; Logout remains DB independent", async (t) => {
  const f = await authFixture(t);
  await f.register();
  const pair = cookiePair(await f.login());
  const blocker = new Database(f.filename, { fileMustExist: true });
  f.db.pragma("busy_timeout = 1");
  try {
    blocker.exec("BEGIN EXCLUSIVE");
    const busy = await f.me(pair);
    expectError(busy, 503, "SERVICE_UNAVAILABLE");
    assert.equal(busy.response.headers.get("set-cookie"), null);
    const login = await f.login();
    expectError(login, 503, "SERVICE_UNAVAILABLE");
    assert.equal(login.response.headers.get("set-cookie"), null);
    const logout = await f.logout(pair);
    assert.equal(logout.response.status, 200);
    expectClear(logout);
  } finally {
    if (blocker.inTransaction) blocker.exec("ROLLBACK");
    blocker.close();
  }
  assert.equal((await f.me(pair)).response.status, 200);
  f.db.close();
  const internal = await f.me(pair);
  expectError(internal, 500, "INTERNAL_ERROR");
  assert.equal(internal.response.headers.get("set-cookie"), null);
});

test("Logout accepts absent/expired/invalid cookies repeatedly, clears scope and never writes Users", async (t) => {
  const f = await authFixture(t);
  const registered = await f.register();
  const pair = cookiePair(await f.login());
  const iat = Math.floor(Date.now() / 1000) - 3601;
  const expired = "semh_auth=" + f.token({ sub: registered.json.data.user.user_id, iat, exp: iat + 3600 });
  const before = f.users();
  const changes = f.changes();
  for (const cookie of [pair, undefined, "semh_auth=invalid", expired, undefined, pair]) {
    const result = await f.logout(cookie);
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.json, { ok: true, data: { logged_out: true } });
    expectClear(result);
  }
  assert.deepEqual(f.users(), before);
  assert.equal(f.changes(), changes);
  // Copied JWT is still valid until expiry; logout is browser cookie deletion, not revocation.
  assert.equal((await f.me(pair)).response.status, 200);
});

test("Register/Login/Logout share Origin, JSON media/syntax/size and preflight policy", async (t) => {
  const f = await authFixture(t);
  for (const route of ["/auth/register", "/auth/login", "/auth/logout"]) {
    const body = route.endsWith("logout") ? {} : credentials;
    for (const origin of [undefined, "null", "http://evil.example", "http://127.0.0.1:5173", "http://localhost:5174"]) {
      const denied = await f.post(route, body, { headers: { Origin: origin } });
      expectError(denied, 403, "ORIGIN_NOT_ALLOWED");
      assert.equal(denied.response.headers.get("set-cookie"), null);
      assert.notEqual(denied.response.headers.get("access-control-allow-origin"), "*");
    }
    for (const type of [undefined, "text/plain", "application/x-www-form-urlencoded"]) {
      expectError(await f.post(route, undefined, {
        raw: Buffer.from(JSON.stringify(body)), headers: { "Content-Type": type },
      }), 415, "UNSUPPORTED_MEDIA_TYPE");
    }
    expectError(await f.post(route, undefined, { raw: "{" }), 400, "INVALID_JSON");
    expectError(await f.post(route, { large: "x".repeat(8192) }), 413, "PAYLOAD_TOO_LARGE");
    const result = await f.request(route, {
      method: "OPTIONS", headers: {
        "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Content-Type",
      },
    });
    assert.equal(result.response.status, 204);
    assert.equal(result.json, null);
    assert.equal(result.response.headers.get("access-control-allow-origin"), f.config.frontendOrigin);
    assert.equal(result.response.headers.get("access-control-allow-credentials"), "true");
    assert.notEqual(result.response.headers.get("access-control-allow-origin"), "*");
  }
  for (const body of [null, [], "body"]) {
    expectError(await f.post("/auth/logout", body), 400, "VALIDATION_ERROR", { _body: "INVALID_TYPE" });
  }
  expectError(await f.post("/auth/logout", { user_id: "client" }), 400, "VALIDATION_ERROR", { user_id: "UNEXPECTED_FIELD" });
  assert.equal(f.users().length, 0);
});

test("Secure cookie issuance/clearing uses matching attributes for configured HTTPS", async (t) => {
  const f = await authFixture(t, { FRONTEND_ORIGIN: "https://localhost:5173", COOKIE_SECURE: "true" });
  await f.register();
  const result = await f.login();
  assert.equal(result.response.status, 200);
  assert.ok(/; Secure(?:;|$)/.test(result.response.headers.get("set-cookie")));
  expectClear(await f.logout(cookiePair(result)), true);
  expectClear(await f.me("semh_auth=bad"), true);
  const jar = new AuthCookieJar();
  jar.apply(result, f.base);
  assert.equal(jar.header(f.base), undefined);
  // Transport is HTTP: this verifies attributes/model, not a live TLS/browser deployment.
  const options = [];
  const res = { cookie: (name, value, opts) => options.push(opts), clearCookie: (name, opts) => options.push(opts) };
  setAuthCookie(res, { secure: true }, { cookieSecure: false }, "unused-fixture");
  clearAuthCookie(res, { secure: true }, { cookieSecure: false });
  assert.equal(options[0].secure, true);
  assert.equal(options[1].secure, true);
  assert.equal(options[0].maxAge, 3600000);
  assert.equal(Object.hasOwn(options[1], "maxAge"), false);
});

test("Register → Login → Me → Logout restores then removes a browser-like cookie without Users mutations", async (t) => {
  const f = await authFixture(t);
  const jar = new AuthCookieJar();
  const registered = await f.register();
  assert.equal(registered.response.status, 201);
  assert.equal(registered.response.headers.get("set-cookie"), null);
  const changes = f.changes();
  const login = await f.login();
  assert.equal(login.response.status, 200);
  jar.apply(login, f.base);
  assert.ok(jar.header(f.base));
  assert.equal(jar.header(f.base.replace("localhost", "127.0.0.1")), undefined);
  assert.equal(jar.header(f.base, "omit"), undefined);
  const me = await f.me(jar.header(f.base));
  assert.deepEqual(me.json, { ok: true, data: { user: registered.json.data.user } });
  const logout = await f.logout(jar.header(f.base));
  jar.apply(logout, f.base);
  assert.equal(jar.header(f.base), undefined);
  const after = await f.me(jar.header(f.base));
  expectError(after, 401, "AUTH_REQUIRED");
  assert.equal(f.changes(), changes);
  assert.equal(f.users().length, 1);
});
