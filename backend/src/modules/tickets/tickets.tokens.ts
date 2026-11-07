/* Tickets module's DI token, kept beside the module so the foundation token
   catalog stays free of business knowledge. */

import { createToken } from "../../bootstrap/Container.js";
import type { TicketServicePort } from "./tickets.types.js";

export const TICKETS_TOKENS = {
  service: createToken<TicketServicePort>("tickets.service"),
} as const;
