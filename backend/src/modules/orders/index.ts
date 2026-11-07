/* Public surface of the Orders module. Other code imports from here, never
   from a file inside it. */

export { OrdersService, denialReasonForSoldOutItem } from "./orders.service.js";
export { OrdersRepository } from "./orders.repository.js";
export {
  createOrdersRouter,
  type OrdersControllerDeps,
} from "./orders.controller.js";
export {
  createOrdersModule,
  type OrdersModule,
  type OrdersModuleOptions,
} from "./orders.module.js";
export { ORDER_EVENTS, NOOP_ORDER_EVENTS } from "./orders.events.js";
export { ORDERS_TOKENS } from "./orders.tokens.js";
export {
  fireSchema,
  ordersListQuerySchema,
  orderStatusParamsSchema,
  orderStatusQuerySchema,
} from "./orders.validation.js";
export type {
  CartLineMove,
  DeniedLineRow,
  DeniedOrderRef,
  DismissedDeniedOrder,
  FiredOrder,
  FireResult,
  FireResultCode,
  LockedOrderRow,
  OrderItem,
  OrderListItem,
  OrdersEventPublisher,
  OrdersListParams,
  OrdersPage,
  OrdersRepositoryPort,
  OrdersSchemaPresence,
  OrdersServicePort,
  OrdersTablePort,
  OrdersTransactionPort,
  OrderStatus,
  OrderStatusRow,
  RequeuedDeniedOrder,
  RetriedDeniedOrder,
} from "./orders.types.js";
