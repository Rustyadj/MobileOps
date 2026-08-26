#!/usr/bin/env node

const { spawn } = require("node:child_process");
const path = require("node:path");

const frontendRoot = path.resolve(__dirname, "..");
const api = spawn(process.execPath, [path.join(__dirname, "demo-api.js")], {
  cwd: frontendRoot,
  stdio: "inherit",
});
const expo = spawn(process.execPath, [path.join(frontendRoot, "node_modules", "expo", "bin", "cli"), "start", "--web", "--port", "8081"], {
  cwd: frontendRoot,
  env: {
    ...process.env,
    EXPO_PUBLIC_DEMO_MODE: "true",
    EXPO_PUBLIC_BACKEND_URL: "http://localhost:8001",
  },
  stdio: "inherit",
});

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  api.kill("SIGTERM");
  expo.kill("SIGTERM");
  setTimeout(() => process.exit(code), 250).unref();
}

api.on("exit", (code) => {
  if (!stopping) stop(code || 1);
});
expo.on("exit", (code) => {
  if (!stopping) stop(code || 0);
});
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

