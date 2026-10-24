const test = require("node:test");
const assert = require("node:assert/strict");
const {
  hashPassword, verifyPassword, PasswordRecordError,
} = require("../src/services/password.service");

test("scrypt records contain approved parameters, independent random salts and verifiable keys", async () => {
  const password = "  Demo🔋e\u0301  ";
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.match(first, /^scrypt\$v1\$N=16384,r=8,p=5,maxmem=67108864\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.notEqual(first, second);
  assert.notEqual(first.split("$")[3], second.split("$")[3]);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword(password, second), true);
  assert.equal(await verifyPassword("wrong-password", first), false);
  assert.equal(await verifyPassword(password.trim(), first), false);
  assert.equal(await verifyPassword(password.normalize("NFC"), first), false);
});

test("password boundaries use Unicode code points, without truncation or normalization", async () => {
  for (const password of ["🔋".repeat(8), "🔋".repeat(128)]) {
    const record = await hashPassword(password);
    assert.equal(await verifyPassword(password, record), true);
  }
  for (const password of ["🔋".repeat(7), "🔋".repeat(129), "", null, 123]) {
    await assert.rejects(hashPassword(password), TypeError);
  }
});

test("malformed/unsupported stored records are distinct from incorrect passwords and cannot set work factors", async () => {
  const record = await hashPassword("fixture-password");
  for (const invalid of [
    undefined, null, "", "plaintext", record + "$extra", record.slice(0, -1),
    record.replace("v1", "v2"), record.replace("N=16384", "N=1073741824"),
    record.replace("p=5", "p=1"), record.replace("maxmem=67108864", "maxmem=1"),
    record.replace(/\$[0-9a-f]{32}\$/, "$invalid$"),
  ]) {
    await assert.rejects(verifyPassword("fixture-password", invalid), PasswordRecordError);
  }
  for (const wrong of ["", null, 123, "x".repeat(129), "different"]) {
    assert.equal(await verifyPassword(wrong, record), false);
  }
});
