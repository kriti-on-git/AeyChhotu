/* Orders module's DI token, kept beside the module so the foundation token
   catalog stays free of business knowledge. */

import { createToken } from "../../bootstrap/Container.js";
import type { OrdersServicePort } from "./orders.types.js";

export const ORDERS_TOKENS = {
  service: createToken<OrdersServicePort>("orders.service"),
} as const;
