const { ConfigError } = require("../src/config/env");
const { LocalDemoError, initializeLocalDemo, startLocalDemo, localDemoStatus, seedLocalDemo } = require("../src/config/local-demo");

async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  const options = {};
  for (const value of rest) {
    const match = /^--(name|student-email)=(.+)$/.exec(value);
    if (!match || Object.hasOwn(options, match[1])) throw new LocalDemoError("Use --name=<new-slug> and, for seed only, --student-email=<dummy-email>.");
    options[match[1]] = match[2];
  }
  if (command !== "seed" && options["student-email"]) throw new LocalDemoError("Student email is only used by the explicit seed command.");
  if (command === "init") {
    const paths = initializeLocalDemo(options.name);
    console.log("Created isolated demo: " + paths.database + ". Signing key saved privately; no data seeded.");
  } else if (command === "status") {
    console.log(JSON.stringify(localDemoStatus(options.name)));
  } else if (command === "seed") {
    console.log(JSON.stringify({ inserted: await seedLocalDemo(options.name, options["student-email"]) }));
  } else if (command === "start") {
    const running = await startLocalDemo(options.name);
    console.log("Isolated demo listening on http://localhost:" + running.server.address().port);
    const stop = () => running.close().catch(() => { console.error("Local demo shutdown failed."); process.exitCode = 1; });
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    // Owned IPC launchers/tests can request a graceful Windows shutdown without
    // adding an HTTP control endpoint or terminating unrelated node processes.
    if (process.send) {
      process.send({ ready: true, port: running.server.address().port });
      process.once("message", async (message) => {
        if (message === "shutdown") { await running.close(); process.disconnect(); }
      });
    }
  } else throw new LocalDemoError("Choose init, start, seed or status.");
}

if (require.main === module) main().catch((error) => {
  console.error(error instanceof LocalDemoError || error instanceof ConfigError ? error.message : "Local demo operation failed safely; existing files were preserved. Check name, target ownership and port availability.");
  process.exitCode = 1;
});
module.exports = { main };
