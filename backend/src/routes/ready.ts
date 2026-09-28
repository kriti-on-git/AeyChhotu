import { Router } from "express";
import { pool } from "../db/pool.js";
import { logEvent } from "../observability/logger.js";

/* GET /api/v1/ready — READINESS probe, distinct from /health (liveness).

   Liveness ("is the process up?") must never touch dependencies, or a
   database blip makes the orchestrator restart a perfectly healthy server
   into the same blip. Readiness ("can we serve real traffic?") is exactly
   where the database check belongs: a failed probe removes this instance
   from the load balancer until the database answers again. */

// Cache a passing result for a few seconds so a fleet of probes doesn't
// turn into a database load test.
const CACHE_MS = 5_000;
let lastOkAt = 0;

export const readyRouter = Router();

readyRouter.get("/", async (_req, res) => {
  if (Date.now() - lastOkAt < CACHE_MS) {
    res.status(200).json({ data: { ready: true, database: "up" } });
    return;
  }

  try {
    // `SELECT 1` over a pooled connection proves auth, DNS, TLS and the
    // query path in one round trip.
    await pool.query("SELECT 1");
    lastOkAt = Date.now();
    res.status(200).json({ data: { ready: true, database: "up" } });
  } catch (err) {
    logEvent("error", "readiness_failed", {
      error_message: err instanceof Error ? err.message : String(err),
    });
    res.status(503).json({
      success: false,
      error: { code: "NOT_READY", message: "Dependency check failed." },
    });
  }
});
