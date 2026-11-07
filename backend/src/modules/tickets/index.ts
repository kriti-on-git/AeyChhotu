/* Public surface of the Tickets module. Other code imports from here, never
   from a file inside it. */

export { TicketsService } from "./tickets.service.js";
export { TicketsRepository } from "./tickets.repository.js";
export {
  createTicketsRouter,
  type TicketsControllerDeps,
} from "./tickets.controller.js";
export {
  createTicketsModule,
  type TicketsModule,
  type TicketsModuleOptions,
} from "./tickets.module.js";
export { TICKET_EVENTS, NOOP_TICKET_EVENTS } from "./tickets.events.js";
export { TICKETS_TOKENS } from "./tickets.tokens.js";
export {
  denyTicketSchema,
  kdsTicketsQuerySchema,
  orderParamsSchema,
  orderStatusSchema,
} from "./tickets.validation.js";
export type {
  ActiveTicketStatus,
  Ticket,
  TicketAdvanceResult,
  TicketAdvanceTarget,
  TicketDenyResult,
  TicketDetail,
  TicketEventPublisher,
  TicketItem,
  TicketLifecycleRow,
  TicketListParams,
  TicketOrderPort,
  TicketOrderRef,
  TicketPage,
  TicketReleasePort,
  TicketRepositoryPort,
  TicketRow,
  TicketSchemaPresence,
  TicketServeResult,
  TicketServicePort,
  TicketStatus,
  TicketStatusRow,
  TicketTable,
  TicketTransactionPort,
} from "./tickets.types.js";
