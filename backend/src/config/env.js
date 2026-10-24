const path = require("node:path");
const dotenv = require("dotenv");

const BACKEND_ROOT = path.resolve(__dirname, "../..");
const PROJECT_ROOT = path.resolve(BACKEND_ROOT, "..");
const DEMO_DATABASE_PATH = path.join(PROJECT_ROOT, "database/smart_mobility.demo.db");
const TEAM_DATABASE_PATH = path.join(PROJECT_ROOT, "database/smart_mobility.db");
const SCHEMA_PATH = path.join(PROJECT_ROOT, "database/schema_sqlite.sql");

class ConfigError extends Error {
  constructor(message) {
    super("Configuration error: " + message);
    this.name = "ConfigError";
  }
}

function samePath(a, b) {
  return process.platform === "win32"
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);
}

function parseConfig(env) {
  const nodeEnv = env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(nodeEnv)) {
    throw new ConfigError("NODE_ENV must be development, test or production.");
  }
  const rawPort = env.PORT ?? "3000";
  if (typeof rawPort !== "string" || !/^\d+$/.test(rawPort)) {
    throw new ConfigError("PORT must be an integer.");
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < (nodeEnv === "test" ? 0 : 1) || port > 65535) {
    throw new ConfigError("PORT must be 1..65535 (0 is allowed only in test mode).");
  }
  const host = env.HOST ?? "localhost";
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new ConfigError("HOST must be a local loopback address.");
  }
  const frontendOrigin = env.FRONTEND_ORIGIN ?? "http://localhost:5173";
  let origin;
  try {
    origin = new URL(frontendOrigin);
  } catch {
    throw new ConfigError("FRONTEND_ORIGIN must be an HTTP(S) origin.");
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username || origin.password ||
    origin.origin !== frontendOrigin
  ) {
    throw new ConfigError("FRONTEND_ORIGIN must be an exact HTTP(S) origin without a path.");
  }

  const rawDatabasePath = env.DATABASE_PATH ?? (
    nodeEnv === "test" ? ":memory:" : "../database/smart_mobility.demo.db"
  );
  if (typeof rawDatabasePath !== "string" || !rawDatabasePath.trim()) {
    throw new ConfigError("DATABASE_PATH must not be empty.");
  }
  let databasePath;
  if (nodeEnv === "test") {
    // Tests cannot redirect startup into either persistent application database.
    if (rawDatabasePath !== ":memory:") {
      throw new ConfigError("Test startup requires DATABASE_PATH=:memory:.");
    }
    databasePath = ":memory:";
  } else {
    databasePath = path.resolve(BACKEND_ROOT, rawDatabasePath);
    if (!samePath(databasePath, DEMO_DATABASE_PATH)) {
      throw new ConfigError("DATABASE_PATH must resolve to the approved smart_mobility.demo.db.");
    }
  }
  const jwtSecret = env.JWT_SECRET || undefined;
  if (jwtSecret !== undefined && (
    typeof jwtSecret !== "string" || !/^[0-9a-fA-F]{64}$/.test(jwtSecret)
  )) {
    throw new ConfigError("JWT_SECRET, when supplied, must contain 64 hexadecimal characters.");
  }
  const rawSecure = env.COOKIE_SECURE;
  if (rawSecure !== undefined && !["true", "false"].includes(rawSecure)) {
    throw new ConfigError("COOKIE_SECURE must be true or false.");
  }
  const cookieSecure = rawSecure === undefined ? origin.protocol === "https:" : rawSecure === "true";
  if (origin.protocol === "https:" && !cookieSecure) {
    throw new ConfigError("HTTPS requires COOKIE_SECURE=true.");
  }
  // Pure config/DB checks may omit JWT. Auth-enabled app/startup must require it.
  return Object.freeze({ nodeEnv, port, host, frontendOrigin, databasePath, jwtSecret, cookieSecure });
}

function requireAuthKey(config) {
  if (typeof config?.jwtSecret !== "string" || !/^[0-9a-fA-F]{64}$/.test(config.jwtSecret)) {
    throw new ConfigError("JWT_SECRET is required for Auth; use 32 random bytes encoded as 64 hex characters.");
  }
  return Buffer.from(config.jwtSecret, "hex");
}

function loadConfig({ env = process.env, envFile } = {}) {
  const values = { ...env };
  // node --test and CLI startup smoke never read a real backend/.env.
  const filename = envFile === undefined
    ? (values.NODE_ENV === "test" ? false : path.join(BACKEND_ROOT, ".env"))
    : envFile;
  if (filename !== false) {
    const result = dotenv.config({ path: filename, processEnv: values, quiet: true });
    if (result.error && result.error.code !== "ENOENT") {
      throw new ConfigError("The environment file could not be loaded.");
    }
  }
  return parseConfig(values);
}

module.exports = {
  loadConfig, parseConfig, requireAuthKey, ConfigError, samePath,
  BACKEND_ROOT, PROJECT_ROOT, DEMO_DATABASE_PATH, TEAM_DATABASE_PATH, SCHEMA_PATH,
};
