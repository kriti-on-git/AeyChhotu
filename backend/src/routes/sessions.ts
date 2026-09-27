import { Router } from "express";
import { activeCheck, initializeSession } from "../services/sessions.service.js";
import { activeCheckParamsSchema, initializeSchema, parseOrThrow } from "../validation/schemas.js";

/* Module 1+2 routes: E1 initialize, E9 anti-duplicate active-check. */
export const sessionsRouter = Router();

// E1 — POST /api/v1/sessions/initialize
sessionsRouter.post("/initialize", async (req, res) => {
  const body = parseOrThrow(initializeSchema, req.body);
  const data = await initializeSession(body.table_token);
  res.status(200).json({ success: true, data });
});

// E9 — GET /api/v1/sessions/:table_token/active-check
sessionsRouter.get("/:table_token/active-check", async (req, res) => {
  const params = parseOrThrow(activeCheckParamsSchema, req.params);
  const data = await activeCheck(params.table_token);
  res.status(200).json({ success: true, data });
});
