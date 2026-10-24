const http = require("node:http");
const { loadConfig, requireAuthKey, ConfigError } = require("./config/env");
const { openDemoDatabase, createTestDatabase } = require("./config/db");
const { createApp } = require("./app");

async function startServer({ config = loadConfig(), createDatabase } = {}) {
  requireAuthKey(config); // Fail closed before opening either test or persistent DB.
  // Trusted composition for the explicit P7 local-demo launcher. It validates
  // ownership/paths before supplying a factory; ordinary CLI/env guards stay intact.
  if (createDatabase !== undefined && typeof createDatabase !== "function") {
    throw new TypeError("createDatabase must be a resource factory.");
  }
  const resource = createDatabase ? createDatabase() : config.nodeEnv === "test"
    ? createTestDatabase({ memory: true })
    : (() => {
      const db = openDemoDatabase(config.databasePath);
      return { db, cleanup: () => { if (db.open) db.close(); } };
    })();
  let server;
  try {
    server = http.createServer(createApp({ config, db: resource.db }));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    resource.cleanup();
    throw error;
  }
  let closing;
  function close() {
    if (!closing) {
      closing = new Promise((resolve, reject) => {
        const timer = setTimeout(() => server.closeAllConnections(), 5000);
        timer.unref();
        server.close((error) => {
          clearTimeout(timer);
          try {
            resource.cleanup();
            if (error) reject(error);
            else resolve();
          } catch (cleanupError) {
            reject(cleanupError);
          }
        });
      });
    }
    return closing;
  }
  return { server, db: resource.db, close };
}

async function main() {
  try {
    // loadConfig happens before any factory opens the DB or starts a socket.
    const config = loadConfig();
    const running = await startServer({ config });
    const host = config.host === "::1" ? "[::1]" : config.host;
    console.log("Server running on http://" + host + ":" + running.server.address().port);
    const shutdown = () => {
      running.close().catch(() => {
        console.error("Shutdown failed.");
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    // Never dump configuration, env, credentials or arbitrary database errors.
    console.error(error instanceof ConfigError ? error.message : "Startup failed: database or network initialization failed.");
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { startServer };
