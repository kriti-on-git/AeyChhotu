/* Public surface of the Cart module. Other code imports from here, never from
   a file inside it. */

export { CartService } from "./cart.service.js";
export { CartRepository } from "./cart.repository.js";
export {
  createCartRouter,
  type CartControllerDeps,
} from "./cart.controller.js";
export {
  createCartModule,
  type CartModule,
  type CartModuleOptions,
} from "./cart.module.js";
export { CART_EVENTS, NOOP_CART_REALTIME } from "./cart.events.js";
export { CART_TOKENS } from "./cart.tokens.js";
export {
  cartAddSchema,
  cartDeleteSchema,
  cartItemParamsSchema,
  cartListQuerySchema,
  cartUpdateSchema,
} from "./cart.validation.js";
export type {
  CartAddInput,
  CartClearResult,
  CartLineInsert,
  CartLineWithTotal,
  CartListParams,
  CartMenuPort,
  CartRealtimeAction,
  CartRealtimePayload,
  CartRealtimePort,
  CartRemovalResult,
  CartRepositoryPort,
  CartRow,
  CartSchemaPresence,
  CartServicePort,
  CartTablePort,
  CartTransactionPort,
  CartUpdateInput,
} from "./cart.types.js";
