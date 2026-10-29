const { authFixture, cookiePair } = require("./auth.helpers");

function seedVehicles(db, userId) {
  db.prepare("INSERT INTO Users(user_id,email,role,password_hash) SELECT 'vehicle-other','vehicle-other@example.invalid','STUDENT',password_hash FROM Users WHERE user_id=?").run(userId);
  db.exec(`INSERT INTO Hubs VALUES ('va','Vehicle Campus','CAMPUS',1),('vb','Vehicle Metro','METRO',0),('ve','Vehicle Empty',NULL,0);
    INSERT INTO ParkingSpaces VALUES ('vp','va','RESERVED');`);
  const add = db.prepare("INSERT INTO Vehicles(vehicle_id,hub_id,type,battery_level,state) VALUES (?,?,?,?,?)");
  for (const row of [["v0","va","Xe đạp điện",0,"AVAILABLE"],["v19","va","Xe đạp điện",19,"AVAILABLE"],
    ["v20","va","Xe máy điện",20,"AVAILABLE"],["v100","vb","Xe đạp điện",100,"AVAILABLE"],
    ["vr","va","Xe máy điện",60,"RESERVED"],["vu",null,"Xe đạp điện",45,"IN_USE"],
    ["vx","vb","Xe máy điện",90,"UNAVAILABLE"],["special /?🔋","vb","Xe đạp điện",75,"AVAILABLE"]]) add.run(...row);
  const reservation = (id, vehicle, state, owner = "vehicle-other") => db.prepare(`INSERT INTO Reservations
    (reservation_id,user_id,type,vehicle_id,start_time,state,created_at) VALUES (?,?,'VEHICLE',?,'2026-10-01T00:00:00Z',?,'2026-10-01T00:00:00Z')`).run(id, owner, vehicle, state);
  reservation("reserved-other", "vr", "RESERVED"); reservation("active-other", "vu", "ACTIVE");
  for (const state of ["COMPLETED", "CANCELLED", "EXPIRED"]) reservation("history-" + state, "v20", state, userId);
  db.prepare(`INSERT INTO Reservations(reservation_id,user_id,type,space_id,start_time,state,created_at)
    VALUES ('parking-kept',?,'PARKING','vp','2026-10-01T00:00:00Z','RESERVED','2026-10-01T00:00:00Z')`).run(userId);
  return { reservation };
}
async function vehicleFixture(t) {
  const f = await authFixture(t);
  const userId = (await f.register()).json.data.user.user_id;
  const cookie = cookiePair(await f.login());
  const seed = seedVehicles(f.db, userId);
  const other = "semh_auth=" + f.token({ sub: "vehicle-other" });
  const route = (id, action) => "/vehicles/" + encodeURIComponent(id) + "/" + action;
  const act = (id, action, body = {}, owner = cookie) => f.post(route(id, action), body, { cookie: owner });
  const get = path => f.request(path, { cookie });
  return { ...f, ...seed, userId, cookie, other, route, act, get };
}
module.exports = { seedVehicles, vehicleFixture };
