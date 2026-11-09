"use strict";

/**
 * Supervisor: keeps index.js alive forever.
 *
 * - Restarts the bot whenever it exits for ANY reason (crash, memory guard, etc).
 * - Backoff only applies to crash loops: if the bot ran 60s+ the delay resets.
 * - Forwards SIGTERM/SIGINT so the host can stop it cleanly.
 *
 * Works on Railway, Render, a VPS, Termux, anywhere Node runs.
 */

const { spawn } = require("child_process");
const path = require("path");

const ENTRY = path.join(__dirname, "index.js");
const HEALTHY_AFTER_MS = 60_000;
const MIN_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;

let child = null;
let stopping = false;
let delay = MIN_DELAY_MS;
let restarts = 0;

function launch() {
  const startedAt = Date.now();
  child = spawn(process.execPath, [ENTRY], { stdio: "inherit", env: process.env });

  child.on("error", (error) => {
    console.error("[SUPERVISOR] failed to spawn:", error?.message || error);
  });

  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return process.exit(0);

    const ranMs = Date.now() - startedAt;
    delay = ranMs >= HEALTHY_AFTER_MS ? MIN_DELAY_MS : Math.min(MAX_DELAY_MS, delay * 2);
    restarts++;
    console.error(
      `[SUPERVISOR] bot exited (code=${code}, signal=${signal}) after ${Math.round(ranMs / 1000)}s. ` +
      `Restart #${restarts} in ${Math.round(delay / 1000)}s`
    );
    setTimeout(launch, delay);
  });
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[SUPERVISOR] ${signal} received, stopping bot`);
  if (!child) return process.exit(0);
  try { child.kill("SIGTERM"); } catch (_) {}
  // If the bot does not exit by itself, force it.
  setTimeout(() => {
    try { if (child) child.kill("SIGKILL"); } catch (_) {}
    process.exit(0);
  }, 5_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (e) => console.error("[SUPERVISOR] uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("[SUPERVISOR] unhandledRejection:", e));

console.log("[SUPERVISOR] starting bot");
launch();
