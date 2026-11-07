/* Kitchen module — request contracts.

   The ticket shapes already have one definition site in the Ticket module;
   re-exporting them keeps the kitchen HTTP contract identical without a
   second validator drifting. E13 stays a kitchen-only shape. */

export {
  denyTicketSchema,
  kdsTicketsQuerySchema,
  orderParamsSchema,
  orderStatusSchema,
} from "../tickets/tickets.validation.js";

export { shiftActivateSchema } from "../../validation/schemas.js";
