/* Staff module's DI token. */

import { createToken } from "../../bootstrap/Container.js";
import type { StaffServicePort } from "./staff.types.js";

export const STAFF_TOKENS = {
  service: createToken<StaffServicePort>("staff.service"),
} as const;
