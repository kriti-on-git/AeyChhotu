/* Orders module — HTTP controller (E8 fire, E15 status, E16 history and the
   denied-round actions).

   Paths, methods, status codes and envelopes are unchanged from the legacy
   router. The controller only validates and delegates; every rule lives in
   the service. */

import { Router } from "express";
import { parseOrThrow } from "../../validation/parse.js";
import type { OrdersServicePort } from "./orders.types.js";
import {
  fireSchema,
  orderStatusParamsSchema,
  orderStatusQuerySchema,
  ordersListQuerySchema,
} from "./orders.validation.js";

export interface OrdersControllerDeps {
  readonly service: OrdersServicePort;
}

export function createOrdersRouter(deps: OrdersControllerDeps): Router {
  const router = Router();

  // E8 — POST /api/v1/orders/fire (atomic inside fire_order())
  router.post("/fire", async (req, res) => {
    const body = parseOrThrow(fireSchema, req.body);
    const data = await deps.service.fireOrder(body.table_token);
    res.status(201).json({ success: true, data });
  });

  // E16 — GET /api/v1/orders?table_token=…
  router.get("/", async (req, res) => {
    const query = parseOrThrow(ordersListQuerySchema, req.query);
    const { data, meta } = await deps.service.listOrders(query);
    res.status(200).json({ success: true, data, meta });
  });

  // E15 — GET /api/v1/orders/:order_id/status?table_token=…
  router.get("/:order_id/status", async (req, res) => {
    const params = parseOrThrow(orderStatusParamsSchema, req.params);
    const query = parseOrThrow(orderStatusQuerySchema, req.query);
    const data = await deps.service.getOrderStatus(params.order_id, query.table_token);
    res.status(200).json({ success: true, data });
  });

  /* POST /api/v1/orders/:order_id/requeue — "Move to list" (and the second
     half of "Retry"): available lines go back into the shared cart for
     editing and the refused ticket is removed. */
  router.post("/:order_id/requeue", async (req, res) => {
    const params = parseOrThrow(orderStatusParamsSchema, req.params);
    const query = parseOrThrow(orderStatusQuerySchema, req.query);
    const data = await deps.service.requeueDeniedOrder(params.order_id, query.table_token);
    res.status(200).json({ success: true, data });
  });

  /* POST /api/v1/orders/:order_id/retry — move, replace and re-fire in one
     server transaction, or roll everything back. */
  router.post("/:order_id/retry", async (req, res) => {
    const params = parseOrThrow(orderStatusParamsSchema, req.params);
    const query = parseOrThrow(orderStatusQuerySchema, req.query);
    const data = await deps.service.retryDeniedOrder(params.order_id, query.table_token);
    res.status(201).json({ success: true, data });
  });

  /* POST /api/v1/orders/:order_id/dismiss — the diner's "Cancel": only a
     denied round may be discarded. */
  router.post("/:order_id/dismiss", async (req, res) => {
    const params = parseOrThrow(orderStatusParamsSchema, req.params);
    const query = parseOrThrow(orderStatusQuerySchema, req.query);
    const data = await deps.service.dismissDeniedOrder(params.order_id, query.table_token);
    res.status(200).json({ success: true, data });
  });

  return router;
}
