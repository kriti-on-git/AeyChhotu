/* Kitchen module — HTTP controller (E10 board, E11 acceptance/prep, E12
   completion/prune, deny, E13 shift, assistant key).

   Paths and payloads are unchanged. The path parameter is still `order_id`
   because that is the published contract; it carries the ticket id, which in
   today's one-round projection is the same UUID. Response bodies are mapped
   down to the legacy keys — the internal `ticket_id` never leaks into the
   advance/prune/deny responses. */

import { Router } from "express";
import { parseOrThrow } from "../../validation/parse.js";
import {
  denyTicketSchema,
  kdsTicketsQuerySchema,
  orderParamsSchema,
  orderStatusSchema,
  shiftActivateSchema,
} from "./kitchen.validation.js";
import type { KitchenServicePort } from "./kitchen.types.js";

export interface KitchenControllerDeps {
  readonly service: KitchenServicePort;
}

export function createKitchenRouter(deps: KitchenControllerDeps): Router {
  const router = Router();

  // E10 — GET /api/v1/kds/tickets
  router.get("/tickets", async (req, res) => {
    const query = parseOrThrow(kdsTicketsQuerySchema, req.query);
    const { data, meta } = await deps.service.getBoard(query);
    res.status(200).json({ success: true, data, meta });
  });

  // E11 — PATCH /api/v1/kds/tickets/:order_id/status
  // `preparing` is ticket acceptance; `ready` completes preparation.
  router.patch("/tickets/:order_id/status", async (req, res) => {
    const params = parseOrThrow(orderParamsSchema, req.params);
    const body = parseOrThrow(orderStatusSchema, req.body);

    const data =
      body.status === "preparing"
        ? await deps.service.acceptTicket(params.order_id)
        : await deps.service.markTicketReady(params.order_id);

    res.status(200).json({
      success: true,
      data: { order_id: data.order_id, status: data.status },
    });
  });

  // PATCH /api/v1/kds/tickets/:order_id/prune — completion leaves the board.
  router.patch("/tickets/:order_id/prune", async (req, res) => {
    const params = parseOrThrow(orderParamsSchema, req.params);
    const data = await deps.service.completeTicket(params.order_id);

    res.status(200).json({
      success: true,
      data: {
        order_id: data.order_id,
        status: data.status,
        table_cleared: data.table_cleared,
      },
    });
  });

  // PATCH /api/v1/kds/tickets/:order_id/deny
  router.patch("/tickets/:order_id/deny", async (req, res) => {
    const params = parseOrThrow(orderParamsSchema, req.params);
    const body = parseOrThrow(denyTicketSchema, req.body);
    const data = await deps.service.denyTicket(params.order_id, body.reason);

    res.status(200).json({
      success: true,
      data: {
        order_id: data.order_id,
        status: data.status,
        denial_reason: data.denial_reason,
        table_cleared: data.table_cleared,
      },
    });
  });

  // E13 — POST /api/v1/kds/shift/activate
  router.post("/shift/activate", async (req, res) => {
    const body = parseOrThrow(shiftActivateSchema, req.body);
    const data = deps.service.activateShift(body.device_id);
    res.status(200).json({ success: true, data });
  });

  /* GET /api/v1/kds/assistant/key — the Live key for the kitchen voice
     assistant. The route wrapper owns the kitchen shift gate. */
  router.get("/assistant/key", (_req, res) => {
    res.status(200).json({
      success: true,
      data: { gemini_api_key: deps.service.assistantKey() },
    });
  });

  return router;
}
