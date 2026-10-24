const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { once } = require("node:events");
const jwt = require("jsonwebtoken");
const { createApp } = require("../src/app");
const { createTestDatabase } = require("../src/config/db");
const { parseConfig, TEAM_DATABASE_PATH, DEMO_DATABASE_PATH } = require("../src/config/env");
const { protectedSnapshot, testEnv } = require("./helpers");

const credentials = { email: "student@example.com", password: "auth-fixture-password" };

async function authFixture(t, overrides = {}) {
  const before = protectedSnapshot();
  const config = parseConfig(testEnv({ HOST: "localhost", ...overrides }));
  const resource = createTestDatabase();
  const { db, filename } = resource;
  assert.notEqual(filename, TEAM_DATABASE_PATH);
  assert.notEqual(filename, DEMO_DATABASE_PATH);
  assert.equal(path.dirname(path.dirname(filename)), fs.realpathSync(os.tmpdir()));
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n, 10);
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
  server.listen(0, "localhost");
  await once(server, "listening");
  const base = "http://localhost:" + server.address().port;
  async function request(route, { method = "GET", body, raw, headers = {}, cookie } = {}) {
    const outgoing = { Origin: config.frontendOrigin, ...headers };
    if (method === "POST" && !Object.hasOwn(outgoing, "Content-Type")) outgoing["Content-Type"] = "application/json";
    if (cookie !== undefined) outgoing.Cookie = cookie;
    for (const key of Object.keys(outgoing)) if (outgoing[key] === undefined) delete outgoing[key];
    const response = await fetch(base + route, {
      method, headers: outgoing,
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    const json = response.status === 204 ? null : await response.json();
    return { response, json };
  }
  const post = (route, body, options = {}) => request(route, { method: "POST", body, ...options });
  const register = (body = credentials) => post("/auth/register", body);
  const login = (body = credentials, options = {}) => post("/auth/login", body, options);
  const me = (cookie, options = {}) => request("/auth/me", { cookie, ...options });
  const logout = (cookie, options = {}) => post("/auth/logout", {}, { cookie, ...options });
  const users = () => db.prepare("SELECT * FROM Users ORDER BY user_id").all();
  const changes = () => db.prepare("SELECT total_changes() n").get().n;
  const token = (claims = {}, options = {}) => {
    const iat = Math.floor(Date.now() / 1000);
    return jwt.sign({
      sub: "missing-user", iat, exp: iat + 3600,
      iss: "smartemobilityhub-api", aud: "smartemobilityhub-web", ...claims,
    }, Buffer.from(config.jwtSecret, "hex"), { algorithm: "HS256", ...options });
  };
  return { ...resource, config, base, request, post, register, login, me, logout, users, changes, token };
}

function cookiePair(result) {
  const value = result.response.headers.get("set-cookie");
  assert.ok(typeof value === "string");
  return value.split(";")[0];
}

function expectError(result, status, code, fields = {}) {
  assert.equal(result.response.status, status);
  assert.deepEqual(Object.keys(result.json).sort(), ["error", "ok"]);
  assert.equal(result.json.ok, false);
  assert.deepEqual(Object.keys(result.json.error).sort(), ["code", "fieldErrors", "message"]);
  assert.equal(result.json.error.code, code);
  assert.deepEqual(result.json.error.fieldErrors, fields);
  assert.equal(typeof result.json.error.message, "string");
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(JSON.stringify(result.json), /password_hash|scrypt\$|SQLITE_|SELECT |INSERT |stack|auth-fixture-password|eyJ/);
}

function expectClear(result, secure = false) {
  const value = result.response.headers.get("set-cookie");
  assert.ok(typeof value === "string");
  assert.ok(value.startsWith("semh_auth=;"));
  assert.ok(/; Path=\//.test(value));
  assert.ok(/; HttpOnly/.test(value));
  assert.ok(/; SameSite=Lax/.test(value));
  assert.equal(/; Secure(?:;|$)/.test(value), secure);
  assert.equal(/; Domain=/i.test(value), false);
  assert.equal(/; Max-Age=/i.test(value), false);
  const expiry = value.match(/; Expires=([^;]+)/);
  assert.ok(expiry && Date.parse(expiry[1]) < Date.now());
}

// Deliberately small browser-like cookie model for the one approved host-only cookie.
// Models host/path/Secure/deletion and credentials mode; not browser/SameSite E2E.
class AuthCookieJar {
  constructor() { this.entry = null; }
  apply(result, url) {
    const header = result.response.headers.get("set-cookie");
    if (!header) return;
    const parsed = new URL(url);
    const secure = /; Secure(?:;|$)/.test(header);
    if (secure && parsed.protocol !== "https:") return;
    const pair = header.split(";")[0];
    const expires = header.match(/; Expires=([^;]+)/);
    if (pair === "semh_auth=" || (expires && Date.parse(expires[1]) <= Date.now())) {
      this.entry = null;
    } else {
      this.entry = { pair, hostname: parsed.hostname, secure };
    }
  }
  header(url, credentialsMode = "include") {
    const parsed = new URL(url);
    if (!this.entry || credentialsMode !== "include" || parsed.hostname !== this.entry.hostname ||
      (this.entry.secure && parsed.protocol !== "https:")) return undefined;
    return this.entry.pair;
  }
}

module.exports = { authFixture, credentials, cookiePair, expectError, expectClear, AuthCookieJar };
