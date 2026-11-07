import { Router } from "express";
import type { HealthPort } from "../infrastructure/health/HealthManager.js";
import { logEvent } from "../observability/logger.js";

/* GET /api/v1/ready — readiness probe, distinct from /health (liveness).

   Every check reads the actual registered components through HealthManager.
   PostgreSQL failure makes the database unhealthy and every dependent
   unhealthy without running dependent hooks; /ready then answers 503. A
   passing result is cached for a few seconds so a fleet of probes does not
   become a database load test. Internal errors, credentials and diagnostics
   never appear in this public response. */

const CACHE_MS = 5_000;
const CHECK_TIMEOUT_MS = 3_000;

export function createReadyRouter(health?: HealthPort): Router {
  const router = Router();
  let lastOkAt = 0;

  router.get("/", async (_req, res) => {
    if (health === undefined) {
      res.status(503).json({
        success: false,
        error: { code: "NOT_READY", message: "Health checks are not initialized." },
      });
      return;
    }

    if (Date.now() - lastOkAt < CACHE_MS) {
      res.status(200).json({ data: { ready: true, database: "up" } });
      return;
    }

    try {
      await health.checkAll({ timeoutMs: CHECK_TIMEOUT_MS });
      const readiness = health.readiness();
      if (!readiness.ready) {
        res.status(503).json({
          success: false,
          error: { code: "NOT_READY", message: "Dependency check failed." },
        });
        return;
      }

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

  return router;
}
