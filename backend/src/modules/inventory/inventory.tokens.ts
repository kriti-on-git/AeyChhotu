/* Inventory module's DI token, kept beside the module so the foundation
   token catalog stays free of business knowledge. */

import { createToken } from "../../bootstrap/Container.js";
import type { InventoryServicePort } from "./inventory.types.js";

export const INVENTORY_TOKENS = {
  service: createToken<InventoryServicePort>("inventory.service"),
} as const;
