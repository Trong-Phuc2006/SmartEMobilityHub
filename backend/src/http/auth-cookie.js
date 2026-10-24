const COOKIE_NAME = "semh_auth";

function cookieOptions(config, req) {
  return {
    httpOnly: true, sameSite: "lax", path: "/",
    secure: config.cookieSecure || req.secure === true,
  };
}

function setAuthCookie(res, req, config, token) {
  res.cookie(COOKIE_NAME, token, { ...cookieOptions(config, req), maxAge: 3600000 });
}

function clearAuthCookie(res, req, config) {
  // No stale maxAge or Domain. Express supplies an expiration in the past.
  res.clearCookie(COOKIE_NAME, cookieOptions(config, req));
}

module.exports = { COOKIE_NAME, setAuthCookie, clearAuthCookie };
