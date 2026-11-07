/* Tickets module — HTTP controller (E10 board, E11 status, E12 prune, deny).

   Paths and payloads are unchanged from the legacy KDS router. The path
   parameter is still named `order_id` because that is the published contract;
   it carries the ticket id, which in today's one-round projection is the same
   UUID. */

import { Router } from "express";
import { parseOrThrow } from "../../validation/parse.js";
import type { TicketServicePort } from "./tickets.types.js";
import {
  denyTicketSchema,
  kdsTicketsQuerySchema,
  orderParamsSchema,
  orderStatusSchema,
} from "./tickets.validation.js";

export interface TicketsControllerDeps {
  readonly service: TicketServicePort;
}

export function createTicketsRouter(deps: TicketsControllerDeps): Router {
  const router = Router();

  // E10 — GET /api/v1/kds/tickets
  router.get("/tickets", async (req, res) => {
    const query = parseOrThrow(kdsTicketsQuerySchema, req.query);
    const { data, meta } = await deps.service.listTickets(query);
    res.status(200).json({ success: true, data, meta });
  });

  // E11 — PATCH /api/v1/kds/tickets/:order_id/status
  router.patch("/tickets/:order_id/status", async (req, res) => {
    const params = parseOrThrow(orderParamsSchema, req.params);
    const body = parseOrThrow(orderStatusSchema, req.body);

    const data = await deps.service.advanceTicket(params.order_id, body.status);
    res.status(200).json({
      success: true,
      data: { order_id: data.order_id, status: data.status },
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

  // E12 — PATCH /api/v1/kds/tickets/:order_id/prune
  router.patch("/tickets/:order_id/prune", async (req, res) => {
    const params = parseOrThrow(orderParamsSchema, req.params);

    const data = await deps.service.pruneTicket(params.order_id);
    res.status(200).json({
      success: true,
      data: {
        order_id: data.order_id,
        status: data.status,
        table_cleared: data.table_cleared,
      },
    });
  });

  return router;
}
