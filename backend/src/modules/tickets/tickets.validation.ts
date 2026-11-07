/* Tickets module — validation.

   Owned here so the kitchen ticket contract has one definition site.
   validation/schemas.ts re-exports these names for existing importers. */

import { z } from "zod";
import { pagination, uuid } from "../../validation/primitives.js";

/** E10 GET /api/v1/kds/tickets */
export const kdsTicketsQuerySchema = z.object({
  status: z.enum(["pending", "preparing", "ready"]).optional(),
  ...pagination,
});

/** E11/PATCH path params — the contract names the ticket `order_id`. */
export const orderParamsSchema = z.object({ order_id: uuid("order_id") });

/** E11 body — only forward moves; `served` is prune-only. */
export const orderStatusSchema = z.object({
  status: z.enum(["preparing", "ready"]),
});

/** Chef's refusal. The reason is mandatory and is what the diner reads. */
export const denyTicketSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Tell the diner why the order was refused.")
    .max(300, "The denial reason must be 300 characters or fewer."),
});
