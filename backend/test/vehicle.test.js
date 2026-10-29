const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const path = require("node:path");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { vehicleFixture } = require("./vehicle.helpers");
const { expectError, expectClear } = require("./auth.helpers");
const { readVehicles, ownVehicleReservations, mutateVehicle } = require("../src/services/vehicle.service");

test("Vehicle GET Auth, current account and request validation use the existing safe contract", async t => {
  const f = await vehicleFixture(t);
  for (const route of ["/vehicles", "/vehicle-reservations"]) {
    for (const [token, code] of [[undefined,"AUTH_REQUIRED"],["bad","SESSION_INVALID"],
      [f.token({sub:f.userId,iat:Math.floor(Date.now()/1000)-3601,exp:Math.floor(Date.now()/1000)-1}),"SESSION_EXPIRED"]]) {
      const r = await f.request(route, { cookie: token && "semh_auth=" + token }); expectError(r,401,code); expectClear(r);
    }
    for (const [field, value, code] of [["status","DISABLED","ACCOUNT_DISABLED"],["role","OPERATOR","ROLE_NOT_SUPPORTED"]]) {
      f.db.prepare(`UPDATE Users SET ${field}=? WHERE user_id=?`).run(value,f.userId);
      expectError(await f.get(route),403,code);
      f.db.prepare("UPDATE Users SET role='STUDENT',status='ACTIVE' WHERE user_id=?").run(f.userId);
    }
  }
  expectError(await f.get("/vehicles?hub_id=missing"),404,"HUB_NOT_FOUND");
  for (const query of ["hub_id=", "hub_id=a&hub_id=b", "hub_id=%00", "hub_id="+"x".repeat(129)]) {
    expectError(await f.get("/vehicles?"+query),400,"VALIDATION_ERROR",{hub_id:"INVALID_HUB_ID"});
  }
  expectError(await f.get("/vehicles?owner=other"),400,"VALIDATION_ERROR",{owner:"UNEXPECTED_FIELD"});
  expectError(await f.get("/vehicle-reservations?user_id=other"),400,"VALIDATION_ERROR",{user_id:"UNEXPECTED_FIELD"});
});

test("Vehicle snapshot is read-only, exact/private, counts four states, supports NULL Hub and empty scopes", async t => {
  const f = await vehicleFixture(t); const changes = f.changes();
  f.db.pragma("query_only=ON");
  const r = await f.get("/vehicles"), data = r.json.data;
  assert.equal(r.response.status,200); assert.equal(r.response.headers.get("cache-control"),"no-store");
  assert.equal(r.response.headers.get("set-cookie"),null);
  assert.deepEqual(data.summary,{total_vehicles:8,available:5,reserved:1,in_use:1,unavailable:1});
  assert.deepEqual(data.vehicles.map(v=>v.battery_level).sort((a,b)=>a-b),[0,19,20,45,60,75,90,100]);
  assert.deepEqual(Object.keys(data.vehicles[0]).sort(),["battery_level","has_current_reservation","hub_id","hub_name","is_mine","state","type","vehicle_id"]);
  assert.deepEqual(data.vehicles.filter(v=>v.state==="IN_USE").map(v=>[v.hub_id,v.hub_name]),[[null,null]]);
  assert.equal(data.vehicles.find(v=>v.vehicle_id==="vr").has_current_reservation,true);
  assert.equal(data.vehicles.find(v=>v.vehicle_id==="v20").has_current_reservation,false);
  assert.doesNotMatch(JSON.stringify(data),/user_id|email|reservation_id|password|vehicle-other/);
  assert.equal((await f.get("/vehicles?hub_id=va")).json.data.vehicles.length,4);
  assert.deepEqual((await f.get("/vehicles?hub_id=ve")).json.data,{vehicles:[],summary:{total_vehicles:0,available:0,reserved:0,in_use:0,unavailable:0}});
  assert.deepEqual((await f.get("/vehicle-reservations")).json.data,{reservations:[]});
  assert.equal(f.changes(),changes);
});

test("reserve 19/20/100 boundary, across-Hub user limit and Parking isolation", async t => {
  const f = await vehicleFixture(t);
  expectError(await f.act("v19","reserve"),409,"BATTERY_TOO_LOW");
  expectError(await f.act("v0","reserve"),409,"BATTERY_TOO_LOW");
  for (const id of ["vr","vu","vx"]) expectError(await f.act(id,"reserve"),409,"VEHICLE_UNAVAILABLE");
  expectError(await f.act("missing","reserve"),404,"VEHICLE_NOT_FOUND");
  expectError(await f.act("\n","reserve"),400,"VALIDATION_ERROR",{vehicleId:"INVALID_VEHICLE_ID"});
  expectError(await f.act("x".repeat(129),"reserve"),400,"VALIDATION_ERROR",{vehicleId:"INVALID_VEHICLE_ID"});
  const r=await f.act("v20","reserve"); assert.equal(r.response.status,201);
  assert.equal(r.json.data.vehicle.is_mine,true); assert.equal(r.json.data.reservations[0].reservation_state,"RESERVED");
  expectError(await f.act("v100","reserve"),409,"ACTIVE_VEHICLE_RESERVATION_EXISTS");
  expectError(await f.act("v20","reserve",{},f.other),409,"VEHICLE_UNAVAILABLE");
  await f.act("v20","cancel"); assert.equal((await f.act("v100","reserve")).response.status,201);
  await f.act("v100","cancel"); assert.equal((await f.act("special /?🔋","reserve")).response.status,201);
  const parking=f.db.prepare("SELECT * FROM Reservations WHERE reservation_id='parking-kept'").get();
  assert.equal(parking.state,"RESERVED"); assert.equal(f.db.prepare("SELECT state FROM ParkingSpaces WHERE space_id='vp'").get().state,"RESERVED");
});

test("pickup/return/cancel enforce owner, legal transitions, history, cross-Hub and battery0/100", async t => {
  const f=await vehicleFixture(t);
  for (const action of ["pickup","cancel","return"]) expectError(await f.act("v20",action,action==="return"?{hub_id:"vb",battery_level:0}:{}),409,"INVALID_VEHICLE_TRANSITION");
  await f.act("v20","reserve");
  for(const action of ["pickup","cancel"]) expectError(await f.act("v20",action,{},f.other),403,"VEHICLE_NOT_OWNED");
  // No invented battery guard for pickup.
  f.db.exec("UPDATE Vehicles SET battery_level=0 WHERE vehicle_id='v20'");
  const pickup=await f.act("v20","pickup"); assert.equal(pickup.response.status,200);
  assert.equal(pickup.json.data.vehicle.state,"IN_USE"); assert.equal(pickup.json.data.vehicle.hub_id,null);
  assert.equal(pickup.json.data.reservations[0].reservation_state,"ACTIVE");
  assert.equal((await f.get("/vehicles?hub_id=va")).json.data.vehicles.some(v=>v.vehicle_id==="v20"),false);
  assert.equal((await f.get("/vehicle-reservations")).json.data.reservations[0].vehicle_id,"v20");
  for(const action of ["pickup","cancel"]) expectError(await f.act("v20",action),409,"INVALID_VEHICLE_TRANSITION");
  expectError(await f.act("v20","return",{hub_id:"vb",battery_level:0},f.other),403,"VEHICLE_NOT_OWNED");
  const returned=await f.act("v20","return",{hub_id:"vb",battery_level:0});assert.equal(returned.response.status,200);
  assert.equal(returned.json.data.vehicle.hub_id,"vb");assert.equal(returned.json.data.vehicle.battery_level,0);assert.equal(returned.json.data.vehicle.state,"AVAILABLE");
  expectError(await f.act("v20","return",{hub_id:"vb",battery_level:100}),409,"INVALID_VEHICLE_TRANSITION");
  await f.act("v100","reserve");await f.act("v100","pickup");await f.act("v100","return",{hub_id:"va",battery_level:100});
  await f.act("v100","reserve");await f.act("v100","cancel");expectError(await f.act("v100","cancel"),409,"INVALID_VEHICLE_TRANSITION");
  const history=f.db.prepare("SELECT * FROM Reservations WHERE type='VEHICLE' AND user_id=?").all(f.userId);
  assert.equal(history.filter(r=>r.state==="COMPLETED").length,3);assert.equal(history.filter(r=>r.state==="CANCELLED").length,2);
  assert.ok(history.filter(r=>r.end_time).every(r=>r.end_time>r.start_time));
  assert.equal(f.db.pragma("foreign_key_check").length,0);
});

test("all mutation guards, exact empty bodies and return field boundaries reject without writes", async t => {
  const f=await vehicleFixture(t);
  for(const action of ["reserve","pickup","return","cancel"]) {
    const route=f.route("v20",action);
    expectError(await f.post(route,{}),401,"AUTH_REQUIRED");
    expectError(await f.post(route,{}, {cookie:f.cookie,headers:{Origin:undefined}}),403,"ORIGIN_NOT_ALLOWED");
    expectError(await f.post(route,{}, {cookie:f.cookie,headers:{"Content-Type":"text/plain"}}),415,"UNSUPPORTED_MEDIA_TYPE");
    expectError(await f.post(route,{}, {cookie:f.cookie,raw:"{"}),400,"INVALID_JSON");
    expectError(await f.post(route,{}, {cookie:f.cookie,raw:" ".repeat(9000)}),413,"PAYLOAD_TOO_LARGE");
    for(const body of [null,[],"text"]) expectError(await f.act("v20",action,body),400,"VALIDATION_ERROR",{_body:"INVALID_TYPE"});
    if(action!=="return") expectError(await f.act("v20",action,{user_id:"other"}),400,"VALIDATION_ERROR",{user_id:"UNEXPECTED_FIELD"});
  }
  await f.act("v20","reserve");await f.act("v20","pickup");
  for(const [battery,code] of [[-1,"INVALID_BATTERY_LEVEL"],[101,"INVALID_BATTERY_LEVEL"],[2.5,"INVALID_BATTERY_LEVEL"],["65","INVALID_TYPE"],[null,"INVALID_TYPE"]]) {
    await t.test("return battery "+JSON.stringify(battery),async()=>expectError(await f.act("v20","return",{hub_id:"vb",battery_level:battery}),400,"VALIDATION_ERROR",{battery_level:code}));
  }
  expectError(await f.act("v20","return",{hub_id:"vb"}),400,"VALIDATION_ERROR",{battery_level:"REQUIRED"});
  for(const hub of [null,"",123,"\n"]) expectError(await f.act("v20","return",{hub_id:hub,battery_level:50}),400,"VALIDATION_ERROR",{hub_id:"INVALID_HUB_ID"});
  expectError(await f.act("v20","return",{battery_level:50}),400,"VALIDATION_ERROR",{hub_id:"REQUIRED"});
  expectError(await f.act("v20","return",{hub_id:"missing",battery_level:50}),404,"HUB_NOT_FOUND");
  expectError(await f.act("v20","return",{hub_id:"vb",battery_level:50,state:"AVAILABLE"}),400,"VALIDATION_ERROR",{state:"UNEXPECTED_FIELD"});
  assert.equal(f.db.prepare("SELECT state FROM Vehicles WHERE vehicle_id='v20'").get().state,"IN_USE");
  const expired=f.token({sub:f.userId,iat:Math.floor(Date.now()/1000)-3601,exp:Math.floor(Date.now()/1000)-1});
  expectError(await f.act("v20","return",{hub_id:"vb",battery_level:50},"semh_auth="+expired),401,"SESSION_EXPIRED");
});

test("integrity detects duplicates, mismatches, orphan users/vehicles and illegal locations without repair", async t=>{
  const f=await vehicleFixture(t);
  const corruptions=[
    ()=>f.reservation("dup","vr","RESERVED"),
    ()=>f.db.exec("UPDATE Reservations SET state='ACTIVE' WHERE reservation_id='reserved-other'"),
    ()=>f.reservation("available-open","v20","RESERVED"),
    ()=>f.db.exec("DELETE FROM Reservations WHERE reservation_id='reserved-other'"),
    ()=>f.db.exec("UPDATE Vehicles SET hub_id=NULL WHERE vehicle_id='vr'"),
    ()=>f.db.exec("UPDATE Vehicles SET hub_id='absent' WHERE vehicle_id='vr'"),
    ()=>f.db.exec("UPDATE Reservations SET vehicle_id='absent' WHERE reservation_id='reserved-other'"),
    ()=>f.db.exec("UPDATE Reservations SET user_id='absent' WHERE reservation_id='reserved-other'"),
    ()=>f.db.exec("UPDATE Reservations SET end_time='2026-10-02T00:00:00Z' WHERE reservation_id='reserved-other'"),
  ];
  for(let i=0;i<corruptions.length;i++) {
    f.db.pragma("foreign_keys=OFF");f.db.pragma("ignore_check_constraints=ON");f.db.exec("SAVEPOINT corruption");corruptions[i]();
    const before=f.changes();
    expectError(await f.get("/vehicles"),500,"DATA_INTEGRITY_ERROR");expectError(await f.get("/vehicle-reservations"),500,"DATA_INTEGRITY_ERROR");
    expectError(await f.act("v100","reserve"),500,"DATA_INTEGRITY_ERROR");assert.equal(f.changes(),before);
    f.db.exec("ROLLBACK TO corruption; RELEASE corruption");f.db.pragma("ignore_check_constraints=OFF");f.db.pragma("foreign_keys=ON");
  }
  // Consistent legacy multiple rentals are visible, never silently selected.
  assert.equal(ownVehicleReservations(f.db,"vehicle-other").length,2);
});

test("Vehicle rollback covers every write and post-write snapshot; busy/locked become safe503", async t=>{
  const f=await vehicleFixture(t);
  const count=()=>f.db.prepare("SELECT COUNT(*) n FROM Reservations WHERE type='VEHICLE'").get().n;
  const initial=count();
  f.db.exec("CREATE TRIGGER vehicle_fail BEFORE UPDATE ON Vehicles BEGIN SELECT RAISE(ABORT,'owned test'); END");
  expectError(await f.act("v20","reserve"),500,"INTERNAL_ERROR");assert.equal(count(),initial);f.db.exec("DROP TRIGGER vehicle_fail");
  const prepare=f.db.prepare;let reads=0;
  f.db.prepare=function(sql){if(sql.includes("FROM Vehicles v") && ++reads===2) throw new Error("snapshot failure");return prepare.call(this,sql);};
  expectError(await f.act("v20","reserve"),500,"INTERNAL_ERROR");f.db.prepare=prepare;assert.equal(count(),initial);
  await f.act("v20","reserve");
  for(const action of ["pickup","cancel"]) {
    f.db.exec("CREATE TRIGGER vehicle_fail BEFORE UPDATE ON Vehicles BEGIN SELECT RAISE(ABORT,'owned test'); END");
    expectError(await f.act("v20",action),500,"INTERNAL_ERROR");assert.equal(f.db.prepare("SELECT state FROM Reservations WHERE vehicle_id='v20' AND state='RESERVED'").get().state,"RESERVED");f.db.exec("DROP TRIGGER vehicle_fail");
  }
  await f.act("v20","pickup");f.db.exec("CREATE TRIGGER vehicle_fail BEFORE UPDATE ON Vehicles BEGIN SELECT RAISE(ABORT,'owned test'); END");
  expectError(await f.act("v20","return",{hub_id:"vb",battery_level:77}),500,"INTERNAL_ERROR");f.db.exec("DROP TRIGGER vehicle_fail");
  assert.equal(f.db.prepare("SELECT hub_id FROM Vehicles WHERE vehicle_id='v20'").get().hub_id,null);
  const locker=new Database(f.filename);try{f.db.pragma("busy_timeout=20");locker.exec("BEGIN IMMEDIATE");expectError(await f.act("v100","reserve"),503,"SERVICE_UNAVAILABLE");locker.exec("ROLLBACK");}finally{locker.close();}
  f.db.prepare=function(sql){if(sql.includes("FROM Vehicles v")) throw Object.assign(new Error("private"),{code:"SQLITE_LOCKED"});return prepare.call(this,sql);};
  expectError(await f.get("/vehicles"),503,"SERVICE_UNAVAILABLE");f.db.prepare=prepare;
});

test("Vehicle reads hold a coherent WAL snapshot across another connection's commit", async t=>{
  const f=await vehicleFixture(t);f.db.pragma("journal_mode=WAL");const writer=new Database(f.filename);writer.pragma("foreign_keys=ON");
  try {
    const prepare=f.db.prepare;let changed=false;
    f.db.prepare=function(sql){const statement=prepare.call(this,sql);if(sql.includes("FROM Vehicles v")){const all=statement.all.bind(statement);statement.all=(...args)=>{const rows=all(...args);if(!changed){changed=true;writer.exec("UPDATE Vehicles SET battery_level=99 WHERE vehicle_id='v20'");}return rows;};}return statement;};
    const first=readVehicles(f.db,f.userId);f.db.prepare=prepare;
    assert.equal(first.vehicles.find(v=>v.vehicle_id==="v20").battery_level,20);
    assert.equal(readVehicles(f.db,f.userId).vehicles.find(v=>v.vehicle_id==="v20").battery_level,99);
  } finally {writer.close();}
});

async function processServer(f,stops) {
  const child=fork(path.join(__dirname,"parking-process.fixture.js"),[],{windowsHide:true,stdio:["ignore","ignore","ignore","ipc"]});
  const exited=once(child,"exit");const ready=once(child,"message");child.send({filename:f.filename,secret:f.config.jwtSecret});
  const [{port}]=await ready;let stopping;
  const close=()=>stopping||=(async()=>{if(child.connected)child.send("shutdown");const timer=setTimeout(()=>child.kill(),8000);try{const [code]=await exited;assert.equal(code,0);}finally{clearTimeout(timer);}})();stops.push(close);
  return {base:"http://localhost:"+port,close};
}
test("two OS processes serialize reserve/user races and pickup-cancel; same-file/key restarts persist history",{timeout:60000},async t=>{
  const stops=[];t.after(async()=>{for(const stop of stops)await stop();});const f=await vehicleFixture(t);
  let a=await processServer(f,stops),b=await processServer(f,stops);
  const act=(s,id,action,owner=f.cookie,body={})=>fetch(s.base+f.route(id,action),{method:"POST",headers:{Origin:f.config.frontendOrigin,"Content-Type":"application/json",Cookie:owner},body:JSON.stringify(body)});
  // Use a third user with no pre-existing rental for the two-user race.
  f.db.prepare("INSERT INTO Users SELECT 'racer','STUDENT','racer@example.invalid',password_hash,'ACTIVE' FROM Users WHERE user_id=?").run(f.userId);
  const rival="semh_auth="+f.token({sub:"racer"});
  let race=await Promise.all([act(a,"v20","reserve"),act(b,"v20","reserve",rival)]);assert.deepEqual(race.map(r=>r.status).sort(),[201,409]);
  await act(a,"v20","cancel",race[0].status===201?f.cookie:rival);
  race=await Promise.all([act(a,"v20","reserve"),act(b,"v100","reserve")]);assert.deepEqual(race.map(r=>r.status).sort(),[201,409]);
  const id=race[0].status===201?"v20":"v100";
  race=await Promise.all([act(a,id,"pickup"),act(b,id,"cancel")]);assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
  if(race[1].status===200){await act(a,id,"reserve");await act(a,id,"pickup");}
  await a.close();await b.close();a=await processServer(f,stops);
  const own=await (await fetch(a.base+"/vehicle-reservations",{headers:{Cookie:f.cookie}})).json();assert.equal(own.data.reservations[0].hub_id,null);
  assert.equal((await fetch(a.base+"/auth/me",{headers:{Cookie:f.cookie}})).status,200);
  assert.equal((await act(a,id,"return",f.cookie,{hub_id:"vb",battery_level:65})).status,200);
  await a.close();a=await processServer(f,stops);
  const rows=await (await fetch(a.base+"/vehicles",{headers:{Cookie:f.cookie}})).json();const v=rows.data.vehicles.find(v=>v.vehicle_id===id);
  assert.equal(v.state,"AVAILABLE");assert.equal(v.hub_id,"vb");assert.equal(v.battery_level,65);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM Reservations WHERE vehicle_id=? AND state='COMPLETED'").get(id).n, id==="v20"?2:1);
  assert.equal(f.db.prepare("SELECT state FROM Reservations WHERE reservation_id='parking-kept'").get().state,"RESERVED");
  assert.throws(()=>mutateVehicle(f.db,{vehicleId:id,userId:f.userId,action:"invalid"}),TypeError);
});
