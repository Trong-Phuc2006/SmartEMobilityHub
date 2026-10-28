const path = require("node:path");
const net = require("node:net");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { ensureLocalDemo, localDemoStatus, demoPaths } = require("../backend/src/config/local-demo");
const { parseConfig } = require("../backend/src/config/env");

const ROOT = path.resolve(__dirname, "..");

async function portFree(port) {
  for (const host of ["127.0.0.1", "::1"]) {
    const server = net.createServer();
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
    } catch { throw new Error("Port " + port + " is occupied or unavailable. Stop the service you own or choose another configured port."); }
    finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
  }
}

function launch(filename, env, label, args = []) {
  const child = fork(filename, args, { cwd: ROOT, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const exited = once(child, "exit");
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => process.stdout.write("[" + label + "] " + chunk));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + " readiness timed out.")), 20000);
    child.once("message", message => { clearTimeout(timer); message.ready ? resolve() : reject(new Error(label + " readiness failed.")); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(label + " exited before becoming ready.")); });
    child.once("error", () => { clearTimeout(timer); reject(new Error(label + " could not start.")); });
  });
  // A later startup error must still be observable while the other service starts.
  ready.catch(() => {});
  let closing;
  return { child, ready, close() {
    return closing ||= (async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (child.connected) child.send("shutdown");
      const timer = setTimeout(() => child.kill(), 8000);
      try { await exited; } finally { clearTimeout(timer); }
    })();
  } };
}

async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(arg => arg !== "--status") || args.length > 1) throw new Error("Use npm run dev:demo or npm run demo:status. Select a separate instance with DEMO_NAME=<safe-slug>.");
  const name = env.DEMO_NAME || "cr01-demo";
  demoPaths(name);
  if (args[0] === "--status") { console.log(JSON.stringify(localDemoStatus(name), null, 2)); return; }
  const rawFrontendPort = env.VITE_DEV_PORT || "5173";
  const frontendPort = Number(rawFrontendPort);
  if (!/^\d+$/.test(rawFrontendPort) || !Number.isInteger(frontendPort) || frontendPort < 1 || frontendPort > 65535) throw new Error("VITE_DEV_PORT must be 1..65535.");
  const config = parseConfig({ HOST: env.HOST || "localhost", PORT: env.PORT || "3000", FRONTEND_ORIGIN: "http://localhost:" + frontendPort, COOKIE_SECURE: "false" });
  const api = "http://localhost:" + config.port;
  if (config.host !== "localhost" || config.port === frontendPort || (env.COOKIE_SECURE && env.COOKIE_SECURE !== "false") ||
    (env.FRONTEND_ORIGIN && env.FRONTEND_ORIGIN !== config.frontendOrigin) || (env.VITE_API_BASE_URL && env.VITE_API_BASE_URL !== api)) {
    throw new Error("Demo requires localhost HTTP, distinct FE/BE ports, and matching FRONTEND_ORIGIN/VITE_API_BASE_URL. COOKIE_SECURE must be false locally.");
  }
  await portFree(config.port); await portFree(frontendPort);
  const children = [];
  let stopping;
  const stop = () => stopping ||= (async () => {
    await Promise.all(children.map(child => child.close()));
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    console.log("Stopped both owned demo services.");
    if (process.connected) process.disconnect();
  })();
  const signal = () => { void stop(); };
  process.once("SIGINT", signal); process.once("SIGTERM", signal);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true); process.stdin.resume();
    process.stdin.on("data", chunk => { if (chunk.includes(3)) signal(); });
  }
  process.on("message", message => { if (message === "shutdown") void stop(); });
  process.once("disconnect", () => { void stop(); });
  try {
    const instance = await ensureLocalDemo(name);
    if (stopping) return;
    console.log((instance.initialized ? "Initialized once: " : "Reusing persistent SQLite: ") + instance.database);
    const childEnv = { ...env, NODE_ENV: "development", HOST: "localhost", PORT: String(config.port), FRONTEND_ORIGIN: config.frontendOrigin,
      COOKIE_SECURE: "false", VITE_DEV_PORT: String(frontendPort), VITE_API_BASE_URL: api };
    const backend = launch(path.join(ROOT, "backend/scripts/local-demo.js"), childEnv, "backend", ["start", "--name=" + name]);
    children.push(backend);
    await backend.ready;
    const frontend = launch(path.join(__dirname, "demo-frontend.mjs"), childEnv, "frontend");
    children.push(frontend);
    await frontend.ready;
    if (backend.child.exitCode !== null || backend.child.signalCode !== null) throw new Error("Backend stopped during frontend startup.");
    for (const resource of children) resource.child.once("exit", () => {
      if (!stopping) { console.error("A demo service stopped; closing its companion."); process.exitCode = 1; void stop(); }
    });
    console.log("Ready: " + config.frontendOrigin + " · API " + api + " · Ctrl+C stops both services. Instance: " + name);
    process.send?.({ ready: true, frontendPort, backendPort: config.port, name });
  } catch (error) { await stop(); throw error; }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, portFree };
