const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, createHmac } = require("node:crypto");
const jwt = require("jsonwebtoken");
const { createTokenService } = require("../src/services/token.service");
const { parseConfig, requireAuthKey, ConfigError } = require("../src/config/env");
const { protectedSnapshot, runNode, testEnv } = require("./helpers");
const { startServer } = require("../src/server");
const { createApp } = require("../src/app");

function fixture() {
  const config = parseConfig({ JWT_SECRET: randomBytes(32).toString("hex") });
  const service = createTokenService(config);
  const key = Buffer.from(config.jwtSecret, "hex");
  const now = Math.floor(Date.now() / 1000);
  const claims = { sub: "fixture-user", iat: now, exp: now + 3600, iss: "smartemobilityhub-api", aud: "smartemobilityhub-web" };
  const sign = (overrides = {}, options = {}) => jwt.sign({ ...claims, ...overrides }, key, { algorithm: "HS256", ...options });
  const raw = (payload) => {
    const body = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url") + "." +
      Buffer.from(JSON.stringify(payload)).toString("base64url");
    return body + "." + createHmac("sha256", key).update(body).digest("base64url");
  };
  return { config, service, key, claims, sign, raw };
}

function rejects(service, value, code) {
  assert.throws(() => service.verify(value), (error) => error.status === 401 && error.code === code);
}

test("JWT issuance has exactly the approved algorithm, identity claims and 3600-second TTL", () => {
  const { service, key } = fixture();
  const token = service.issue("trusted-id");
  const result = jwt.verify(token, key, {
    algorithms: ["HS256"], issuer: "smartemobilityhub-api", audience: "smartemobilityhub-web", complete: true,
  });
  assert.equal(result.header.alg, "HS256");
  assert.deepEqual(Object.keys(result.payload).sort(), ["aud", "exp", "iat", "iss", "sub"]);
  assert.equal(result.payload.exp - result.payload.iat, 3600);
  assert.equal(result.payload.sub, "trusted-id");
  assert.deepEqual(service.verify(token), { userId: "trusted-id" });
  assert.throws(() => service.issue(undefined));
});

test("JWT verification rejects missing, malformed, tampered and wrongly signed tokens", () => {
  const { service, claims, sign } = fixture();
  rejects(service, undefined, "AUTH_REQUIRED");
  for (const token of [null, "", "bad.token", "not-a-jwt", {}, [], "x".repeat(4097)]) {
    rejects(service, token, "SESSION_INVALID");
  }
  const original = sign();
  const parts = original.split(".");
  parts[1] = Buffer.from(JSON.stringify({ ...claims, sub: "tampered" })).toString("base64url");
  rejects(service, parts.join("."), "SESSION_INVALID");
  rejects(service, jwt.sign(claims, randomBytes(32), { algorithm: "HS256" }), "SESSION_INVALID");
});

test("JWT verifies issuer/audience/algorithm/required claim types and distinguishes expiration", async (t) => {
  const { service, claims, sign, raw } = fixture();
  const iat = Math.floor(Date.now() / 1000) - 3601;
  rejects(service, sign({ iat, exp: iat + 3600 }), "SESSION_EXPIRED");
  const cases = [
    ["wrong issuer", sign({ iss: "other" })],
    ["wrong audience", sign({ aud: "other" })],
    ["array audience", sign({ aud: ["smartemobilityhub-web", "other"] })],
    ["HS384", sign({}, { algorithm: "HS384" })],
    ["unsigned", jwt.sign(claims, null, { algorithm: "none" })],
    ["missing sub", raw({ ...claims, sub: undefined })],
    ["object sub", raw({ ...claims, sub: {} })],
    ["missing expiry", raw({ ...claims, exp: undefined })],
    ["missing issued time", raw({ ...claims, iat: undefined })],
    ["string expiry", raw({ ...claims, exp: String(claims.exp) })],
    ["string issued time", raw({ ...claims, iat: String(claims.iat) })],
    ["future issued time", raw({ ...claims, iat: claims.iat + 1000, exp: claims.exp + 1000 })],
    ["wrong TTL", sign({ exp: claims.exp + 1000 })],
    ["not active yet", sign({ nbf: claims.iat + 3600 })],
    ["expired and wrong issuer", sign({ iat, exp: iat + 3600, iss: "other" })],
  ];
  for (const [name, token] of cases) {
    await t.test(name, () => rejects(service, token, "SESSION_INVALID"));
  }
});

test("Auth startup requires a secret before any DB open; pure config/database checks remain secret-free", async () => {
  const before = protectedSnapshot();
  assert.equal(parseConfig({}).jwtSecret, undefined);
  assert.throws(() => createApp({ config: parseConfig({}) }), ConfigError);
  for (const secret of [undefined, "", "bad", "ab".repeat(31)]) {
    const config = { ...parseConfig({ NODE_ENV: "test" }), jwtSecret: secret };
    await assert.rejects(startServer({ config }), ConfigError);
    assert.throws(() => requireAuthKey(config), ConfigError);
  }
  for (const secret of ["", "invalid", randomBytes(31).toString("hex")]) {
    const result = runNode(["src/server.js"], { env: testEnv({ JWT_SECRET: secret }) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Configuration error:.*JWT_SECRET/);
    assert.equal(result.stdout.includes("Server running"), false);
  }
  // Prove the gate runs even before SQLite constructor invocation.
  const result = runNode(["-e", [
    "const p=require.resolve('better-sqlite3');require.cache[p]={id:p,filename:p,loaded:true,exports:class{constructor(){process.exit(91)}}};",
    "require('./src/server').startServer({config:require('./src/config/env').parseConfig({})}).then(()=>process.exit(92),e=>process.exit(e.name==='ConfigError'?0:93))",
  ].join("")], { env: testEnv({ JWT_SECRET: "" }) });
  assert.equal(result.status, 0);
  assert.equal(requireAuthKey(parseConfig({ JWT_SECRET: randomBytes(32).toString("hex") })).length, 32);
  assert.deepEqual(protectedSnapshot(), before);
});

test("cookie Secure configuration is centralized and rejects unsafe HTTPS overrides", () => {
  assert.equal(parseConfig({}).cookieSecure, false);
  assert.equal(parseConfig({ FRONTEND_ORIGIN: "https://localhost:5173" }).cookieSecure, true);
  assert.equal(parseConfig({ COOKIE_SECURE: "true" }).cookieSecure, true);
  for (const options of [{ COOKIE_SECURE: "invalid" }, { FRONTEND_ORIGIN: "https://localhost:5173", COOKIE_SECURE: "false" }]) {
    assert.throws(() => parseConfig(options), ConfigError);
  }
});
