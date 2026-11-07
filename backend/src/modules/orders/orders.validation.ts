/* Orders module — validation.

   Owned here so the module's HTTP contract has a single definition site.
   validation/schemas.ts re-exports these names for existing importers. */

import { z } from "zod";
import { pagination, tableToken, uuid } from "../../validation/primitives.js";

/** E8 POST /api/v1/orders/fire */
export const fireSchema = z.object({ table_token: tableToken });

/** E16 GET /api/v1/orders */
export const ordersListQuerySchema = z.object({ table_token: tableToken, ...pagination });

/** E15 GET /api/v1/orders/:order_id/status — the table_token query is the
    scope check: an order id alone must not be a universal reader. */
export const orderStatusParamsSchema = z.object({ order_id: uuid("order_id") });
export const orderStatusQuerySchema = z.object({ table_token: tableToken });
