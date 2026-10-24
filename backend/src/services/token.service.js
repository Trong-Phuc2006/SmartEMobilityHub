const jwt = require("jsonwebtoken");
const { requireAuthKey } = require("../config/env");
const { ApiError } = require("../http/errors");

const ISSUER = "smartemobilityhub-api";
const AUDIENCE = "smartemobilityhub-web";
const TTL_SECONDS = 3600;

function sessionError(code) {
  return new ApiError(401, code, code === "SESSION_EXPIRED"
    ? "Phiên đăng nhập đã hết hạn."
    : code === "AUTH_REQUIRED" ? "Vui lòng đăng nhập." : "Phiên đăng nhập không hợp lệ.");
}

function createTokenService(config) {
  const key = requireAuthKey(config);
  function issue(userId) {
    if (typeof userId !== "string" || !userId) throw new Error("Trusted user identity required.");
    return jwt.sign({}, key, {
      algorithm: "HS256", subject: userId, issuer: ISSUER, audience: AUDIENCE,
      expiresIn: TTL_SECONDS,
    });
  }
  function verify(token) {
    if (token === undefined) throw sessionError("AUTH_REQUIRED");
    if (typeof token !== "string" || !token || token.length > 4096) {
      throw sessionError("SESSION_INVALID");
    }
    let payload;
    let expired = false;
    try {
      // Verify signature + algorithm/issuer/audience before classifying expiration.
      payload = jwt.verify(token, key, {
        algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE,
      });
    } catch (error) {
      if (!(error instanceof jwt.TokenExpiredError)) throw sessionError("SESSION_INVALID");
      expired = true;
      // TokenExpiredError occurs before issuer/audience checks in this library.
      // Re-verify all other claims, still requiring a valid signature.
      try {
        payload = jwt.verify(token, key, {
          algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE, ignoreExpiration: true,
        });
      } catch {
        throw sessionError("SESSION_INVALID");
      }
    }
    const now = Math.floor(Date.now() / 1000);
    if (
      !payload || typeof payload !== "object" || Array.isArray(payload) ||
      typeof payload.sub !== "string" || !payload.sub ||
      !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
      payload.iat < 0 || payload.iat > now ||
      payload.exp - payload.iat !== TTL_SECONDS ||
      payload.iss !== ISSUER || payload.aud !== AUDIENCE
    ) throw sessionError("SESSION_INVALID");
    if (expired) throw sessionError("SESSION_EXPIRED");
    return Object.freeze({ userId: payload.sub });
  }
  return Object.freeze({ issue, verify });
}

module.exports = { createTokenService };
