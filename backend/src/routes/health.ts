import { Router } from "express";
import type { HealthPort } from "../infrastructure/health/HealthManager.js";

/* GET /api/v1/health — liveness probe.

   Liveness answers only "is this process able to keep running?". It never
   touches PostgreSQL, so a database blip cannot make an orchestrator restart
   a perfectly healthy API into the same blip. The public payload stays the
   documented shape; details live behind protected diagnostics. */

export function createHealthRouter(health?: HealthPort): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    const live = health?.liveness().alive ?? true;
    res.status(live ? 200 : 503).json({ data: { ok: live } });
  });

  return router;
}
