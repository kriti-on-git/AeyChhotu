/* Billing module — HTTP controller.

   Additive endpoints; no existing path or payload changes. The legacy
   `PATCH /api/v1/floor/tables/:table_id/settle` keeps its exact response and
   now delegates to this same service. */

import { Router } from "express";
import { parseOrThrow } from "../../validation/parse.js";
import { billingTableParamsSchema } from "./billing.validation.js";
import type { BillingServicePort } from "./billing.types.js";

export interface BillingControllerDeps {
  readonly service: BillingServicePort;
}

export function createBillingRouter(deps: BillingControllerDeps): Router {
  const router = Router();

  // GET /api/v1/billing/tables/:table_id — generated bill for this seating.
  router.get("/tables/:table_id", async (req, res) => {
    const params = parseOrThrow(billingTableParamsSchema, req.params);
    const data = await deps.service.getBill(params.table_id);
    res.status(200).json({ success: true, data });
  });

  // PATCH /api/v1/billing/tables/:table_id/settle — same settlement result.
  router.patch("/tables/:table_id/settle", async (req, res) => {
    const params = parseOrThrow(billingTableParamsSchema, req.params);
    const data = await deps.service.settleBill(params.table_id);
    res.status(200).json({ success: true, data });
  });

  return router;
}
