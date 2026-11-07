import { z } from "zod";
import { uuid } from "../../validation/primitives.js";

/** Shared path params for the additive billing endpoints. */
export const billingTableParamsSchema = z.object({
  table_id: uuid("table_id"),
});
