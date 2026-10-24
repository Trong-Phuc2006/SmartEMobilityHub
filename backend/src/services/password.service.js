const { randomBytes, scrypt, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");

const derive = promisify(scrypt);
const PARAMETERS = Object.freeze({ N: 16384, r: 8, p: 5, maxmem: 64 * 1024 * 1024 });
const KEY_BYTES = 64;
const SALT_BYTES = 16;
// v1 accepts only the approved bounded parameters; records cannot request arbitrary work.
const PREFIX = "scrypt$v1$N=16384,r=8,p=5,maxmem=67108864$";

class PasswordRecordError extends Error {
  constructor() {
    super("Unsupported or malformed password record.");
    this.name = "PasswordRecordError";
  }
}

async function hashPassword(password) {
  if (typeof password !== "string" || [...password].length < 8 || [...password].length > 128) {
    throw new TypeError("Password must contain 8..128 Unicode code points.");
  }
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, KEY_BYTES, PARAMETERS);
  return PREFIX + salt.toString("hex") + "$" + key.toString("hex");
}

async function verifyPassword(password, record) {
  if (typeof record !== "string" || !record.startsWith(PREFIX)) {
    throw new PasswordRecordError();
  }
  const parts = record.slice(PREFIX.length).split("$");
  if (
    parts.length !== 2 ||
    !/^[0-9a-f]{32}$/.test(parts[0]) ||
    !/^[0-9a-f]{128}$/.test(parts[1])
  ) {
    throw new PasswordRecordError();
  }
  // A wrong input is distinct from corrupt storage; P3 must map either safely to HTTP.
  if (typeof password !== "string" || [...password].length < 1 || [...password].length > 128) {
    return false;
  }
  const actual = await derive(password, Buffer.from(parts[0], "hex"), KEY_BYTES, PARAMETERS);
  return timingSafeEqual(actual, Buffer.from(parts[1], "hex"));
}

module.exports = { hashPassword, verifyPassword, PasswordRecordError };
