const express = require("express");
const cors = require("cors");
const cookie = require("cookie");
const { createTokenService } = require("./services/token.service");
const { createAuthRouter } = require("./routes/auth.routes");
const { createParkingRouter, createOwnParkingRouter } = require("./routes/parking.routes");
const { ApiError, errorHandler } = require("./http/errors");

function createApp({ config, db } = {}) {
  if (!config?.frontendOrigin) {
    throw new Error("createApp requires explicit validated configuration.");
  }
  const tokens = createTokenService(config);
  const app = express();
  app.locals.db = db;
  app.use(cors({ origin: config.frontendOrigin, credentials: true }));
  app.use((req, res, next) => {
    req.cookies = cookie.parse(req.headers.cookie || "");
    next();
  });
  app.use("/auth", createAuthRouter({ config, db, tokens }));
  app.use("/hubs", createParkingRouter({ config, db, tokens }));
  app.use("/parking-reservations", createOwnParkingRouter({ config, db, tokens }));
  app.get("/", (req, res) => {
    res.json({ ok: true, data: { message: "Smart E-Mobility Hub API is running" } });
  });
  app.use((req, res, next) => next(new ApiError(404, "NOT_FOUND", "Không tìm thấy tài nguyên.")));
  app.use(errorHandler);
  return app;
}

// No env loading, DB opening or listening socket at import.
module.exports = { createApp };
