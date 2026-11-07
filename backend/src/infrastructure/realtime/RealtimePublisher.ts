/* RealtimePublisher — the ONLY realtime surface a business module may use.

   A service publishes a fact to a room; it never touches a Socket.IO Server,
   a socket, a room adapter or an ack callback. That keeps the transport
   replaceable and, more importantly, makes a service testable without a
   network: the tests inject a fake publisher and assert what was published.

   ROOMS ARE A SERVER DECISION
   * `table:<table_id>` — the diners of exactly one table;
   * `kitchen`, `floor`, `admin` — the role rooms;
   * `staff` — every authenticated staff terminal.
   A client cannot ask to join a room it is not entitled to (IOManager checks
   the token's role / table session on every request).

   NOT the internal EventManager: that bus carries in-process facts with no
   transport, no rooms and no serialization. This interface is the outward
   edge and is allowed to lose a message when a phone is offline. */

export interface RealtimeEnvelope {
  readonly id: string;
  readonly event: string;
  readonly room: string;
  readonly at: string;
  readonly sequence: number;
  readonly data: unknown;
}

export interface PublishResult {
  readonly room: string;
  readonly event: string;
  /** Sockets currently in the room. 0 is normal (nobody is listening). */
  readonly recipients: number;
  /** True when realtime is not running; the message was deliberately not sent. */
  readonly skipped: boolean;
}

export interface RealtimePublisher {
  /** One table's diners. `tableId` is the database id, not the table token. */
  toTable(tableId: string, event: string, data: unknown): PublishResult;
  toKitchen(event: string, data: unknown): PublishResult;
  toFloor(event: string, data: unknown): PublishResult;
  toAdmin(event: string, data: unknown): PublishResult;
  toStaff(event: string, data: unknown): PublishResult;
  /** Public catalogue room. The payload is sanitised before publishing. */
  toMenu(event: string, data: unknown): PublishResult;
  /** Escape hatch for wiring code. The room name is still validated. */
  toRoom(room: string, event: string, data: unknown): PublishResult;
}

export const STAFF_ROOM = "staff";
export const KITCHEN_ROOM = "kitchen";
export const FLOOR_ROOM = "floor";
export const ADMIN_ROOM = "admin";
/** Every guest may subscribe to the public catalogue. */
export const MENU_ROOM = "menu";

/** The single server→client channel that carries every published event. */
export const SERVER_EVENT_CHANNEL = "realtime:event";
export const READY_CHANNEL = "realtime:ready";
export const ERROR_CHANNEL = "realtime:error";

/** Client→server channels. Deliberately namespaced: a domain event name is
    never a socket event name, so a client cannot forge `order.created`. */
export const JOIN_CHANNEL = "realtime:join";
export const LEAVE_CHANNEL = "realtime:leave";

export function tableRoom(tableId: string): string {
  return `table:${tableId}`;
}

/** Rooms this transport may address, plus table rooms by id. */
export const ROOM_PATTERN = /^(staff|kitchen|floor|admin|menu|table:[A-Za-z0-9_-]{1,64})$/;

/** Domain-oriented event names only: lowercase, dot-separated. */
export const EVENT_NAME_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;

/** A payload larger than this is a bug, not a message worth broadcasting. */
export const MAX_PAYLOAD_CHARS = 64_000;

/* Internal catalogue fields that must never reach a guest socket. The public
   menu event carries names, prices, descriptions, photos and availability —
   never cost, stock counts, supplier identity or private notes. */
const PRIVATE_MENU_KEYS = new Set([
  "cost",
  "cost_price",
  "unit_cost",
  "purchase_price",
  "margin",
  "stock",
  "stock_quantity",
  "stock_qty",
  "supplier",
  "supplier_id",
  "supplier_name",
  "internal_notes",
  "internal_note",
  "admin_notes",
  "supplier_contact",
  "supplier_email",
  "supplier_phone",
  "supplier_address",
  "participant_id",
  "participant_token",
  "session_secret",
  "realtime_token",
  "access_token",
  "refresh_token",
  "token",
  "secret",
  "api_key",
  "gemini_api_key",
  "authorization",
]);

export function publicMenuPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => publicMenuPayload(entry));
  if (value === null || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (PRIVATE_MENU_KEYS.has(key.toLowerCase())) continue;
    output[key] = publicMenuPayload(entry);
  }
  return output;
}
