const express = require("express");
const { createRequireAuth } = require("../middleware/auth");
const { listHubs, readParking } = require("../services/parking.service");

function createParkingRouter({ config, db, tokens }) {
  const router = express.Router();
  const requireAuth = createRequireAuth({ config, db, tokens });
  router.get("/", requireAuth, (req, res) => {
    res.json({ ok: true, data: { hubs: listHubs(db) } });
  });
  router.get("/:hubId/parking-spaces", requireAuth, (req, res) => {
    res.json({ ok: true, data: readParking(db, req.params.hubId, req.auth.user_id) });
  });
  return router;
}

module.exports = { createParkingRouter };
