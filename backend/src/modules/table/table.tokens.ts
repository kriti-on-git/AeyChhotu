/* Table module's DI tokens. Kept in the module folder so the foundation
   token catalog stays free of business knowledge (phase 1 decision). */

import { createToken } from "../../bootstrap/Container.js";
import type { TableServicePort } from "./table.types.js";

export const TABLE_TOKENS = {
  service: createToken<TableServicePort>("table.service"),
} as const;
