/* Transitional facade over the Tickets module.

   Historical callers (tests, scripts) import listTickets / advanceStatus /
   pruneTicket / denyTicket from this file. It holds no SQL and no rules: it
   delegates to the single TicketsService composed at boot. E13 shift arming
   stays here because it belongs to the Kitchen surface, not the ticket
   aggregate, and is process-local by design. */

import { getDefaultKitchenService } from "./kitchen.service.js";
import { getDefaultTicketsService } from "./tickets.service.js";

export type {
  Ticket as KdsTicket,
  TicketAdvanceTarget as KdsAdvanceTarget,
  TicketDenyResult as DenyTicketResult,
} from "../modules/tickets/index.js";

export function listTickets(params: {
  status?: string;
  page: number;
  limit: number;
}) {
  return getDefaultTicketsService().listTickets(params);
}

export function advanceStatus(orderId: string, target: "preparing" | "ready") {
  return getDefaultTicketsService().advanceTicket(orderId, target);
}

export function pruneTicket(orderId: string) {
  return getDefaultTicketsService().pruneTicket(orderId);
}

export function denyTicket(orderId: string, reason: string) {
  return getDefaultTicketsService().denyTicket(orderId, reason);
}

/* E13 — POST /api/v1/kds/shift/activate. The registry now lives in the
   Kitchen module; this alias keeps historical imports working. */
export function armShift(deviceId: string) {
  return getDefaultKitchenService().activateShift(deviceId);
}
