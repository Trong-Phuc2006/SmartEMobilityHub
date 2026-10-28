const express = require("express");
const { createRequireAuth } = require("../middleware/auth");
const { listHubs, readParking, ownReservations, mutateParking } = require("../services/parking.service");
const { postGuards, emptyBody } = require("../http/post-guards");

function createParkingRouter({ config, db, tokens }) {
  const router = express.Router();
  const requireAuth = createRequireAuth({ config, db, tokens });
  router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/", requireAuth, (req, res) => {
    res.json({ ok: true, data: { hubs: listHubs(db) } });
  });
  router.get("/:hubId/parking-spaces", requireAuth, (req, res) => {
    res.json({ ok: true, data: readParking(db, req.params.hubId, req.auth.user_id) });
  });
  for (const action of ["reserve", "arrive", "release"]) {
    router.post("/:hubId/parking-spaces/:spaceId/" + action, ...postGuards(config), requireAuth, (req, res) => {
      emptyBody(req.body);
      const data = mutateParking(db, { ...req.params, userId: req.auth.user_id, action });
      res.status(action === "reserve" ? 201 : 200).json({ ok: true, data });
    });
  }
  return router;
}

function createOwnParkingRouter({ config, db, tokens }) {
  const router = express.Router();
  router.get("/", createRequireAuth({ config, db, tokens }), (req, res) => {
    res.set("Cache-Control", "no-store").json({ ok: true, data: { reservations: ownReservations(db, req.auth.user_id) } });
  });
  return router;
}
module.exports = { createParkingRouter, createOwnParkingRouter };
