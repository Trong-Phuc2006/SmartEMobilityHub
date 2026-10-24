const { randomUUID, randomBytes } = require("node:crypto");
const { hashPassword, verifyPassword } = require("./password.service");
const { ApiError } = require("../http/errors");

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function validateCredentials(body, minimumPasswordLength) {
  const fields = Object.create(null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Dữ liệu chưa hợp lệ.", { _body: "INVALID_TYPE" });
  }
  for (const key of Object.keys(body)) {
    if (key !== "email" && key !== "password") fields[key] = "UNEXPECTED_FIELD";
  }
  if (!Object.hasOwn(body, "email")) fields.email = "REQUIRED";
  else if (typeof body.email !== "string") fields.email = "INVALID_TYPE";
  else {
    const email = normalizeEmail(body.email);
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      fields.email = "INVALID_EMAIL";
    }
  }
  if (!Object.hasOwn(body, "password")) fields.password = "REQUIRED";
  else if (typeof body.password !== "string") fields.password = "INVALID_TYPE";
  else if ([...body.password].length < minimumPasswordLength || [...body.password].length > 128) {
    fields.password = "PASSWORD_LENGTH";
  }
  if (Object.keys(fields).length) {
    throw new ApiError(400, "VALIDATION_ERROR", "Dữ liệu chưa hợp lệ.", fields);
  }
  return { email: normalizeEmail(body.email), password: body.password };
}

function emailExists() {
  return new ApiError(409, "EMAIL_EXISTS", "Email đã được đăng ký.", { email: "EMAIL_EXISTS" });
}

async function registerUser(db, body) {
  const { email, password } = validateCredentials(body, 8);
  const passwordHash = await hashPassword(password);
  const user = { user_id: randomUUID(), email, role: "STUDENT" };
  try {
    // Hash outside the write lock; recheck + INSERT atomically across connections.
    db.transaction(() => {
      // SQLite NOCASE/LOWER handle ASCII only. Match JS normalization for existing
      // Unicode/mixed-case rows as well, without modifying teammates' records.
      const duplicate = db.prepare("SELECT email FROM Users").iterate();
      for (const row of duplicate) {
        if (normalizeEmail(row.email) === email) throw emailExists();
      }
      db.prepare(
        "INSERT INTO Users (user_id, role, email, password_hash, status) VALUES (?, ?, ?, ?, ?)",
      ).run(user.user_id, user.role, user.email, passwordHash, "ACTIVE");
    }).immediate();
    return user;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") throw emailExists();
    if (error.code?.startsWith("SQLITE_BUSY") || error.code?.startsWith("SQLITE_LOCKED")) {
      throw new ApiError(503, "SERVICE_UNAVAILABLE", "Dịch vụ tạm thời bận. Vui lòng thử lại.");
    }
    throw error; // Central handler sends a safe 500, never the SQLite message.
  }
}

function assertSupportedAccount(user) {
  if (user.status !== "ACTIVE") {
    throw new ApiError(403, "ACCOUNT_DISABLED", "Tài khoản không hoạt động.");
  }
  if (user.role !== "STUDENT") {
    throw new ApiError(403, "ROLE_NOT_SUPPORTED", "Vai trò chưa được hỗ trợ.");
  }
}

function publicUser(user) {
  return { user_id: user.user_id, email: user.email, role: user.role };
}

function readUser(db, id) {
  return db.prepare("SELECT user_id,email,role,status FROM Users WHERE user_id=?").get(id);
}

// Lazily generated, private dummy record: unknown email also performs scrypt work.
let dummyRecord;
async function loginUser(db, body) {
  const { email, password } = validateCredentials(body, 1);
  let id;
  // Use exactly P2 Unicode normalization; do not rely on ASCII-only SQLite NOCASE.
  for (const row of db.prepare("SELECT user_id,email FROM Users").iterate()) {
    if (normalizeEmail(row.email) === email) {
      if (id !== undefined) throw new Error("Ambiguous normalized account identity.");
      id = row.user_id;
    }
  }
  const user = id === undefined ? undefined : db.prepare(
    "SELECT user_id,password_hash FROM Users WHERE user_id=?",
  ).get(id);
  if (!user && !dummyRecord) dummyRecord = hashPassword(randomBytes(32).toString("hex"));
  // Malformed stored records throw; the common handler returns a safe internal error.
  const correct = await verifyPassword(password, user ? user.password_hash : await dummyRecord);
  if (!user || !correct) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Email hoặc mật khẩu không đúng.");
  }
  const current = readUser(db, user.user_id);
  if (!current) throw new ApiError(401, "INVALID_CREDENTIALS", "Email hoặc mật khẩu không đúng.");
  assertSupportedAccount(current);
  return publicUser(current);
}

function sessionUser(db, id) {
  const user = readUser(db, id);
  if (!user) throw new ApiError(401, "SESSION_INVALID", "Phiên đăng nhập không hợp lệ.");
  assertSupportedAccount(user);
  return publicUser(user);
}

module.exports = { registerUser, loginUser, sessionUser, normalizeEmail };
