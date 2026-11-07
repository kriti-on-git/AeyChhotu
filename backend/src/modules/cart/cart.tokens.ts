/* Cart module's DI token, kept beside the module so the foundation token
   catalog stays free of business knowledge. */

import { createToken } from "../../bootstrap/Container.js";
import type { CartServicePort } from "./cart.types.js";

export const CART_TOKENS = {
  service: createToken<CartServicePort>("cart.service"),
} as const;
