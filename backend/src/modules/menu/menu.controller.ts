/* Menu module — public HTTP controller.

   E3 menu retrieval, the diner folder tree, dish photos and E14 86ing. The
   image reader is injected: image storage is a separate capability, and this
   controller only knows the two-field result it renders. */

import { Router } from "express";
import { AppError } from "../../errors/app-error.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { parseOrThrow } from "../../validation/parse.js";
import type { MenuServicePort } from "./menu.types.js";
import {
  availabilitySchema,
  menuImageParamsSchema,
  menuItemParamsSchema,
  menuQuerySchema,
} from "./menu.validation.js";

export type MenuImageSize = "original" | "small" | "tiny";

export interface MenuControllerDeps {
  readonly service: MenuServicePort;
  readonly readImage: (
    menuItemId: string,
    size: MenuImageSize,
  ) => Promise<{ bytes: Buffer; contentType: string } | null>;
}

export function createMenuRouter(deps: MenuControllerDeps): Router {
  const router = Router();

  // E3 — GET /api/v1/menu?table_token=…
  router.get("/", async (req, res) => {
    const query = parseOrThrow(menuQuerySchema, req.query);
    const { data, meta } = await deps.service.listMenu(query);
    res.status(200).json({ success: true, data, meta });
  });

  /* GET /api/v1/menu/items/:menu_item_id/image/:size — public on purpose:
     it is the same picture a diner sees, and keys rotate on replacement so
     the immutable cache is safe. */
  router.get("/items/:menu_item_id/image/:size", async (req, res) => {
    const params = parseOrThrow(menuImageParamsSchema, req.params);
    const image = await deps.readImage(params.menu_item_id, params.size);

    if (!image) {
      throw new AppError(404, "IMAGE_NOT_FOUND", "No photo for this dish.");
    }

    res.setHeader("Content-Type", image.contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Content-Length", String(image.bytes.length));
    res.status(200).send(image.bytes);
  });

  // GET /api/v1/menu/categories — names-only folder tree.
  router.get("/categories", async (_req, res) => {
    const data = await deps.service.listPublicCategories();
    res.status(200).json({ success: true, data });
  });

  // E14 — PATCH /api/v1/menu/items/:menu_item_id/availability
  router.patch(
    "/items/:menu_item_id/availability",
    requireAuth,
    requireRole("kitchen"),
    async (req, res) => {
      const params = parseOrThrow(menuItemParamsSchema, req.params);
      const body = parseOrThrow(availabilitySchema, req.body);
      const data = await deps.service.setAvailability(params.menu_item_id, body.is_available);
      res.status(200).json({ success: true, data });
    },
  );

  return router;
}
