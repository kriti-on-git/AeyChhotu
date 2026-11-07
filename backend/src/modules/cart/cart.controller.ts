/* Cart module — HTTP controller (E4 read, E5 upsert, E6 update, E7 remove).
   Paths, status codes and envelopes are unchanged from the legacy router. */

import { Router } from "express";
import { parseOrThrow } from "../../validation/parse.js";
import {
  cartAddSchema,
  cartDeleteSchema,
  cartItemParamsSchema,
  cartListQuerySchema,
  cartUpdateSchema,
} from "./cart.validation.js";
import type { CartServicePort } from "./cart.types.js";

export interface CartControllerDeps {
  readonly service: CartServicePort;
}

export function createCartRouter(deps: CartControllerDeps): Router {
  const router = Router();

  // E4 — GET /api/v1/cart/items?table_token=…
  router.get("/", async (req, res) => {
    const query = parseOrThrow(cartListQuerySchema, req.query);
    const { data, meta } = await deps.service.listCart(query);
    res.status(200).json({ success: true, data, meta });
  });

  // E5 — POST /api/v1/cart/items
  router.post("/", async (req, res) => {
    const body = parseOrThrow(cartAddSchema, req.body);
    const data = await deps.service.addItem(body);
    res.status(200).json({ success: true, data });
  });

  // E6 — PATCH /api/v1/cart/items/:cart_item_id
  router.patch("/:cart_item_id", async (req, res) => {
    const params = parseOrThrow(cartItemParamsSchema, req.params);
    const body = parseOrThrow(cartUpdateSchema, req.body);
    const data = await deps.service.updateItem(params.cart_item_id, body);
    res.status(200).json({ success: true, data });
  });

  // E7 — DELETE /api/v1/cart/items
  router.delete("/", async (req, res) => {
    const body = parseOrThrow(cartDeleteSchema, req.body);
    const data = await deps.service.removeItem(body.table_token, body.cart_item_id);
    res.status(200).json({ success: true, data });
  });

  return router;
}
