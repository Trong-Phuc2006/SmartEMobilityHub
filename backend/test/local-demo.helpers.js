const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { initializeLocalDemo, LOCAL_DEMO_ROOT, demoPaths } = require("../src/config/local-demo");
const { samePath } = require("../src/config/env");

function localDemoFixture(t, { fresh = false } = {}) {
  const name = "p7-test-" + randomBytes(8).toString("hex");
  const paths = fresh ? demoPaths(name) : initializeLocalDemo(name); // Exclusive, task-owned name.
  if (fresh && fs.existsSync(paths.directory)) throw new Error("Test fixture name collision; existing files were preserved.");
  t.after(() => {
    const resolved = path.resolve(paths.directory);
    if (!fs.existsSync(resolved)) return;
    if (!samePath(path.dirname(resolved), LOCAL_DEMO_ROOT) || path.basename(resolved) !== name ||
      !name.startsWith("p7-test-") || fs.lstatSync(resolved).isSymbolicLink() ||
      !samePath(fs.realpathSync(resolved), resolved)) throw new Error("Refusing cleanup outside owned P7 fixture.");
    const marker = JSON.parse(fs.readFileSync(paths.marker, "utf8"));
    if (marker.name !== name || marker.kind !== "SmartEMobilityHub isolated local demo v1") throw new Error("Refusing cleanup with mismatched test ownership marker.");
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return paths;
}
module.exports = { localDemoFixture };
