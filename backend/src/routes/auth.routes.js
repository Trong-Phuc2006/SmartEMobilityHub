const express = require("express");
const { registerUser, loginUser } = require("../services/auth.service");
const { ApiError } = require("../http/errors");
const { setAuthCookie, clearAuthCookie } = require("../http/auth-cookie");
const { createRequireAuth } = require("../middleware/auth");

function createAuthRouter({ config, db, tokens }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  const postGuards = [
    (req, res, next) => {
      if (req.get("Origin") !== config.frontendOrigin) {
        return next(new ApiError(403, "ORIGIN_NOT_ALLOWED", "Origin không được phép."));
      }
      const type = req.get("Content-Type")?.split(";")[0].trim().toLowerCase();
      if (type !== "application/json") {
        return next(new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Chỉ hỗ trợ application/json."));
      }
      next();
    },
    // Valid JSON primitives/arrays are rejected by validation, not syntax handling.
    express.json({ limit: "8kb", strict: false }),
  ];
  router.post("/register", ...postGuards, async (req, res) => {
    const user = await registerUser(db, req.body);
    res.status(201).json({ ok: true, data: { user } });
  });
  router.post("/login", ...postGuards, async (req, res) => {
    const user = await loginUser(db, req.body);
    setAuthCookie(res, req, config, tokens.issue(user.user_id));
    res.json({ ok: true, data: { user } });
  });
  router.post("/logout", ...postGuards, (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Dữ liệu chưa hợp lệ.", { _body: "INVALID_TYPE" });
    }
    const fields = Object.fromEntries(Object.keys(body).map((key) => [key, "UNEXPECTED_FIELD"]));
    if (Object.keys(fields).length) {
      throw new ApiError(400, "VALIDATION_ERROR", "Dữ liệu chưa hợp lệ.", fields);
    }
    // No JWT verification or DB dependency: clearing a cookie is idempotent.
    clearAuthCookie(res, req, config);
    res.json({ ok: true, data: { logged_out: true } });
  });
  router.get("/me", createRequireAuth({ config, db, tokens }), (req, res) => {
    res.json({ ok: true, data: { user: req.auth } });
  });
  return router;
}

module.exports = { createAuthRouter };
