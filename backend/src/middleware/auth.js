const { sessionUser } = require("../services/auth.service");
const { ApiError } = require("../http/errors");
const { COOKIE_NAME, clearAuthCookie } = require("../http/auth-cookie");

function createRequireAuth({ config, db, tokens }) {
  return (req, res, next) => {
    res.set("Cache-Control", "no-store");
    try {
      const { userId } = tokens.verify(req.cookies?.[COOKIE_NAME]);
      req.auth = Object.freeze(sessionUser(db, userId));
      next();
    } catch (error) {
      // Retryable DB/internal failures preserve the browser session.
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        clearAuthCookie(res, req, config);
      }
      next(error);
    }
  };
}

module.exports = { createRequireAuth };
