class ApiError extends Error {
  constructor(status, code, message, fieldErrors = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  let safe = error instanceof ApiError ? error : null;
  if (!safe && (error.code?.startsWith("SQLITE_BUSY") || error.code?.startsWith("SQLITE_LOCKED"))) {
    safe = new ApiError(503, "SERVICE_UNAVAILABLE", "Dịch vụ tạm thời bận. Vui lòng thử lại.");
  }
  if (!safe && error.type === "entity.parse.failed") {
    safe = new ApiError(400, "INVALID_JSON", "JSON không hợp lệ.");
  } else if (!safe && error.type === "entity.too.large") {
    safe = new ApiError(413, "PAYLOAD_TOO_LARGE", "Dữ liệu vượt quá 8 KiB.");
  } else if (!safe && error.status === 415) {
    safe = new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Chỉ hỗ trợ application/json UTF-8.");
  }
  if (!safe) {
    safe = new ApiError(500, "INTERNAL_ERROR", "Không thể xử lý yêu cầu.");
  }
  // Never serialize/log arbitrary Error objects, parser bodies or SQL messages.
  res.set("Cache-Control", "no-store");
  res.status(safe.status).json({
    ok: false,
    error: { code: safe.code, message: safe.message, fieldErrors: safe.fieldErrors },
  });
}

module.exports = { ApiError, errorHandler };
