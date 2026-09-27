import { Router } from "express";

/* GET /api/v1/health — liveness probe. Exact payload per spec:
   { "data": { "ok": true } } */
export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.status(200).json({ data: { ok: true } });
});
