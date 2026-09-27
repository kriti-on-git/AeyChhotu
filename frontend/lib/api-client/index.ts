/* Public surface of the API client module.

   Usage:
     import { loginKDS, getKdsTickets, ApiError } from "@/lib/api-client";

   Runtime values are re-exported explicitly (no `export *` on value
   modules) so every consumer — webpack, tsx, jest — sees identical named
   exports regardless of module format. */

export * from "./types";
export { ApiError, isApiError } from "./errors";
export { getKdsToken, storeKdsToken, clearKdsToken } from "./token";
export {
  getBaseUrl,
  apiRequest,
  REQUEST_TIMEOUT_MS,
  KDS_LOGIN_PATH,
  type RequestOptions,
  type ApiResult,
} from "./apiClient";
export {
  initializeSession,
  loginKDS,
  getMe,
  checkActiveOrder,
  getMenu,
  getCartItems,
  upsertCartItem,
  updateCartItem,
  removeCartItem,
  fireTableOrder,
  getKdsTickets,
  updateKdsStatus,
  pruneKdsTicket,
  activateShift,
  toggleItemAvailability,
  getLiveOrderStatus,
  getOrders,
  getFloorTables,
} from "./endpoints";
export {
  getSupabase,
  subscribeTableCart,
  subscribeKdsOrders,
  subscribeOrderTracker,
  trackTablePresence,
  watchOrderStatus,
  type CartChangeEvent,
  type KdsIntakeEvent,
  type OrderTrackerEvent,
  type WatchOptions,
} from "./realtime";
export {
  isOfflineError,
  apiErrorFromServiceFailure,
  toTable,
  toMenuItem,
  toCartLine,
  toOrder,
  toKdsOrder,
} from "./normalize";
