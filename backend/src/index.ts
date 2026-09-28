import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { pool } from "./db/pool.js";
import { logEvent } from "./observability/logger.js";

/* App entry. Importing config/env.js validates required env vars and exits
   loudly if any are missing; importing db/pool.js wires the Postgres pool. */

const app = createApp();

const server = app.listen(env.port, () => {
  logEvent("info", "server_started", {
    port: env.port,
    node_env: env.nodeEnv,
    cors_origins: env.clientUrls,
  });
});

/* Graceful shutdown. Render/Fly/Kubernetes kill with SIGTERM and expect the
   process to finish in-flight requests before exiting; a hard kill mid-order
   is how a diner's fire turns into a 502. Sequence:
     1. stop ACCEPTING new connections (load balancer routes elsewhere)
     2. let in-flight requests finish (bounded — a hung socket must not
        hold the process hostage past the platform's own kill timeout)
     3. close the Postgres pool so the exit is clean, not a pile of ECONNRESET */
const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;

function shutdown(signal: "SIGTERM" | "SIGINT"): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logEvent("info", "shutdown_begin", { signal });

  server.close(async () => {
    try {
      await pool.end();
      logEvent("info", "shutdown_complete", {});
      process.exit(0);
    } catch (err) {
      logEvent("error", "shutdown_pool_error", {
        error_message: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  });

  // Bounded drain: if sockets won't die (keep-alive clients), force it
  // before the platform's SIGKILL makes the exit look like a crash.
  setTimeout(() => {
    logEvent("warn", "shutdown_forced", { timeout_ms: SHUTDOWN_TIMEOUT_MS });
    server.closeAllConnections();
    void pool.end().finally(() => process.exit(0));
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
