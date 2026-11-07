/* Kitchen module's DI tokens. */

import { createToken } from "../../bootstrap/Container.js";
import type { KitchenServicePort } from "./kitchen.types.js";

export const KITCHEN_TOKENS = {
  service: createToken<KitchenServicePort>("kitchen.service"),
} as const;
