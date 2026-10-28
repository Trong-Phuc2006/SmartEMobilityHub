const express = require("express");
const { ApiError } = require("./errors");

function postGuards(config) {
  return [(req, res, next) => {
    if (req.get("Origin") !== config.frontendOrigin) return next(new ApiError(403, "ORIGIN_NOT_ALLOWED", "Origin không được phép."));
    if (req.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return next(new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Chỉ hỗ trợ application/json."));
    }
    next();
  }, express.json({ limit: "8kb", strict: false })];
}
function emptyBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "VALIDATION_ERROR", "Dữ liệu chưa hợp lệ.", { _body: "INVALID_TYPE" });
  const fields = Object.fromEntries(Object.keys(body).map((key) => [key, "UNEXPECTED_FIELD"]));
  if (Object.keys(fields).length) throw new ApiError(400, "VALIDATION_ERROR", "Dữ liệu chưa hợp lệ.", fields);
}
module.exports = { postGuards, emptyBody };
