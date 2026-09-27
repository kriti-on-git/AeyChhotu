import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { listFloorTables } from "../services/floor.service.js";
import { floorQuerySchema, parseOrThrow } from "../validation/schemas.js";

/* Module 4 — E17 GET /api/v1/floor/tables (staff-gated Floor View feed). */
export const floorRouter = Router();

floorRouter.get("/tables", requireAuth, async (req, res) => {
  const query = parseOrThrow(floorQuerySchema, req.query);
  const { data, meta } = await listFloorTables(query);
  res.status(200).json({ success: true, data, meta });
});
