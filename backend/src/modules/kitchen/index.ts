/* Public surface of the Kitchen module. Other code imports from here, never
   from a file inside it. */

export { KitchenService } from "./kitchen.service.js";
export { KitchenRepository } from "./kitchen.repository.js";
export {
  createKitchenRouter,
  type KitchenControllerDeps,
} from "./kitchen.controller.js";
export {
  createKitchenModule,
  type KitchenModule,
  type KitchenModuleOptions,
} from "./kitchen.module.js";
export {
  KITCHEN_EVENTS,
  KITCHEN_REALTIME_EVENTS,
  NOOP_KITCHEN_EVENTS,
} from "./kitchen.events.js";
export { KITCHEN_TOKENS } from "./kitchen.tokens.js";
export {
  denyTicketSchema,
  kdsTicketsQuerySchema,
  orderParamsSchema,
  orderStatusSchema,
  shiftActivateSchema,
} from "./kitchen.validation.js";
export type {
  KitchenAdvanceResult,
  KitchenAdvanceTarget,
  KitchenBoard,
  KitchenBoardParams,
  KitchenDenyResult,
  KitchenEventPublisher,
  KitchenIncomingTicket,
  KitchenOrderPort,
  KitchenOrderRef,
  KitchenQueueRow,
  KitchenQueueSummary,
  KitchenRealtimePayload,
  KitchenRealtimePort,
  KitchenRepositoryPort,
  KitchenSchemaPresence,
  KitchenServeResult,
  KitchenServicePort,
  KitchenTicketPort,
  ShiftActivation,
} from "./kitchen.types.js";
