const express = require("express");
const { createRequireAuth } = require("../middleware/auth");
const { postGuards, emptyBody } = require("../http/post-guards");
const { ApiError } = require("../http/errors");
const { readVehicles, ownVehicleReservations, mutateVehicle } = require("../services/vehicle.service");

function validateQuery(query, allowed = []) {
  const fields = Object.fromEntries(Object.keys(query).filter(k => !allowed.includes(k)).map(k => [k, "UNEXPECTED_FIELD"]));
  if (Object.keys(fields).length) throw new ApiError(400, "VALIDATION_ERROR", "Dữ liệu chưa hợp lệ.", fields);
}
function createVehicleRouter({ config, db, tokens }) {
  const router = express.Router();
  const auth = createRequireAuth({ config, db, tokens });
  router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/", auth, (req, res) => {
    validateQuery(req.query, ["hub_id"]);
    res.json({ ok: true, data: readVehicles(db, req.auth.user_id, req.query.hub_id) });
  });
  for (const action of ["reserve", "pickup", "return", "cancel"]) {
    router.post("/:vehicleId/" + action, ...postGuards(config), auth, (req, res) => {
      if (action !== "return") emptyBody(req.body);
      const data = mutateVehicle(db, { vehicleId: req.params.vehicleId, userId: req.auth.user_id, action, body: req.body });
      res.status(action === "reserve" ? 201 : 200).json({ ok: true, data });
    });
  }
  return router;
}
function createOwnVehicleRouter({ config, db, tokens }) {
  const router = express.Router();
  router.get("/", createRequireAuth({ config, db, tokens }), (req, res) => {
    validateQuery(req.query);
    res.json({ ok: true, data: { reservations: ownVehicleReservations(db, req.auth.user_id) } });
  });
  return router;
}
module.exports = { createVehicleRouter, createOwnVehicleRouter };
