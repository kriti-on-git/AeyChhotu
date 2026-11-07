/* Table module — domain events it publishes.

   The module owns the names and payloads; the composition root decides how
   they reach the EventManager. Keeping that adapter outside the module means
   the service never imports the transport or the global event catalog, and a
   unit test can pass a recording fake. */

import type { BillStatus } from "./table.types.js";

export type TableClearReason = "auto_release" | "staff_clear" | "admin_clear";

export interface TableEventPublisher {
  /** A guest claimed an empty table and a new session was stored. */
  sessionStarted(event: { readonly tableId: string; readonly code: string }): void;
  /** A seating ended and the table is empty for the next party. */
  sessionCleared(event: {
    readonly tableId: string;
    readonly reason: TableClearReason;
    readonly billStatus: BillStatus;
  }): void;
  /** A diner asked for the bill (only on the unrequested → requested edge). */
  billRequested(event: { readonly tableId: string; readonly code: string }): void;
}

export const NOOP_TABLE_EVENTS: TableEventPublisher = Object.freeze({
  sessionStarted: () => undefined,
  sessionCleared: () => undefined,
  billRequested: () => undefined,
});
