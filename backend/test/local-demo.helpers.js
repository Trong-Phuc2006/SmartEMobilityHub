const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { initializeLocalDemo, LOCAL_DEMO_ROOT } = require("../src/config/local-demo");
const { samePath } = require("../src/config/env");

function localDemoFixture(t) {
  const name = "p7-test-" + randomBytes(8).toString("hex");
  const paths = initializeLocalDemo(name); // Exclusive mkdir: no pre-existing data.
  t.after(() => {
    const resolved = path.resolve(paths.directory);
    if (!samePath(path.dirname(resolved), LOCAL_DEMO_ROOT) || path.basename(resolved) !== name ||
      !name.startsWith("p7-test-") || fs.lstatSync(resolved).isSymbolicLink() ||
      !samePath(fs.realpathSync(resolved), resolved)) throw new Error("Refusing cleanup outside owned P7 fixture.");
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return paths;
}
module.exports = { localDemoFixture };
