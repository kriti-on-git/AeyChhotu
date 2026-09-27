import { Router } from "express";
import { listMenu, setAvailability } from "../services/menu.service.js";
import {
  availabilitySchema,
  menuItemParamsSchema,
  menuQuerySchema,
  parseOrThrow,
} from "../validation/schemas.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

/* Module 2 E3 (live menu, public) + Module 4 E14 (86ing, staff). */
export const menuRouter = Router();

// E3 — GET /api/v1/menu?table_token=…
menuRouter.get("/", async (req, res) => {
  const query = parseOrThrow(menuQuerySchema, req.query);
  const { data, meta } = await listMenu(query);
  res.status(200).json({ success: true, data, meta });
});

// E14 — PATCH /api/v1/menu/items/:menu_item_id/availability
// (administrative change: requireAuth → 401, requireRole → 403)
menuRouter.patch("/items/:menu_item_id/availability", requireAuth, requireRole("kitchen"), async (req, res) => {
  const params = parseOrThrow(menuItemParamsSchema, req.params);
  const body = parseOrThrow(availabilitySchema, req.body);
  const data = await setAvailability(params.menu_item_id, body.is_available);
  res.status(200).json({ success: true, data });
});
