/* Inventory module — HTTP controller.

   Additive surface; no existing path changes. Reads are open to every staff
   role (floor, kitchen, admin) because the floor needs low-stock awareness.
   Writes are admin-only: changing a count is a management action, while the
   kitchen's existing 86 switch (PATCH /menu/items/:id/availability) keeps its
   own contract and role. */

import { Router } from "express";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { parseOrThrow } from "../../validation/parse.js";
import type { InventoryServicePort } from "./inventory.types.js";
import {
  adjustStockSchema,
  inventoryItemParamsSchema,
  inventoryMovementsQuerySchema,
  inventoryQuerySchema,
  restoreStockSchema,
  setStockSchema,
} from "./inventory.validation.js";

export interface InventoryControllerDeps {
  readonly service: InventoryServicePort;
}

const READ_ROLES = ["floor", "kitchen", "admin"] as const;

export function createInventoryRouter(deps: InventoryControllerDeps): Router {
  const router = Router();

  router.use(requireAuth, requireRole(...READ_ROLES));

  // GET /api/v1/inventory?state=low — stock list + summary.
  router.get("/", async (req, res) => {
    const query = parseOrThrow(inventoryQuerySchema, req.query);
    const data = await deps.service.listStock(query);
    res.status(200).json({ success: true, data });
  });

  // GET /api/v1/inventory/items/:menu_item_id
  router.get("/items/:menu_item_id", async (req, res) => {
    const params = parseOrThrow(inventoryItemParamsSchema, req.params);
    const data = await deps.service.getItem(params.menu_item_id);
    res.status(200).json({ success: true, data });
  });

  // GET /api/v1/inventory/items/:menu_item_id/movements?limit=20
  router.get("/items/:menu_item_id/movements", async (req, res) => {
    const params = parseOrThrow(inventoryItemParamsSchema, req.params);
    const query = parseOrThrow(inventoryMovementsQuerySchema, req.query);
    const movements = await deps.service.listMovements(params.menu_item_id, query.limit);
    res.status(200).json({
      success: true,
      data: { count: movements.length, movements },
    });
  });

  // PATCH /api/v1/inventory/items/:menu_item_id — absolute stock/threshold.
  router.patch(
    "/items/:menu_item_id",
    requireRole("admin"),
    async (req, res) => {
      const params = parseOrThrow(inventoryItemParamsSchema, req.params);
      const body = parseOrThrow(setStockSchema, req.body);
      const data = await deps.service.setStock(params.menu_item_id, body);
      res.status(200).json({ success: true, data });
    },
  );

  // POST /api/v1/inventory/items/:menu_item_id/adjustments — signed delta.
  router.post(
    "/items/:menu_item_id/adjustments",
    requireRole("admin"),
    async (req, res) => {
      const params = parseOrThrow(inventoryItemParamsSchema, req.params);
      const body = parseOrThrow(adjustStockSchema, req.body);
      const data = await deps.service.adjustStock(params.menu_item_id, body);
      res.status(200).json({ success: true, data });
    },
  );

  // POST /api/v1/inventory/items/:menu_item_id/restore — positive restoration.
  router.post(
    "/items/:menu_item_id/restore",
    requireRole("admin"),
    async (req, res) => {
      const params = parseOrThrow(inventoryItemParamsSchema, req.params);
      const body = parseOrThrow(restoreStockSchema, req.body);
      const data = await deps.service.restoreStock(params.menu_item_id, body);
      res.status(200).json({ success: true, data });
    },
  );

  return router;
}
