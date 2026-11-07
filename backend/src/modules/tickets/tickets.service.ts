/* Tickets module — business rules.

   The ticket's status machine lives here:
     pending → preparing → ready → served (prune only)
   plus denial from any live status. Every move is one atomic, conditional
   write; an illegal or repeated move is a 409 carrying `current_status`, never
   a best-effort second update.

   Ticket creation is materialized by `fire_order()` inside the same
   transaction that creates the order — the projection is therefore never
   observable before its lines exist. This module owns the created ticket's
   identity, items and lifecycle from that moment on. */

import { AppError } from "../../errors/app-error.js";
import { buildMeta, iso } from "../../lib/util.js";
import type {
  Ticket,
  TicketAdvanceResult,
  TicketAdvanceTarget,
  TicketDenyResult,
  TicketDetail,
  TicketEventPublisher,
  TicketListParams,
  TicketOrderPort,
  TicketPage,
  TicketReleasePort,
  TicketRepositoryPort,
  TicketRow,
  TicketServeResult,
  TicketServicePort,
  TicketTable,
  ActiveTicketStatus,
} from "./tickets.types.js";

export interface TicketsServiceDeps {
  readonly repository: TicketRepositoryPort;
  readonly orders?: TicketOrderPort;
  readonly release?: TicketReleasePort;
  readonly events?: TicketEventPublisher;
  readonly onPublishError?: (err: unknown) => void;
}

const NEXT_STATUS: Record<TicketAdvanceTarget, string> = {
  preparing: "pending",
  ready: "preparing",
};

const LIVE_STATUSES: readonly string[] = ["pending", "preparing", "ready"];

function notFound(): AppError {
  return new AppError(404, "ORDER_NOT_FOUND", "That ticket no longer exists.");
}

function toTicket(row: TicketRow): Ticket {
  return {
    ticket_id: row.ticket_id,
    order_id: row.order_id,
    table: row.table as TicketTable,
    status: row.status,
    created_at: iso(row.created_at),
    items: row.items ?? [],
  };
}

export class TicketsService implements TicketServicePort {
  private readonly repository: TicketRepositoryPort;
  private readonly orders: TicketOrderPort;
  private readonly release?: TicketReleasePort;
  private readonly events?: TicketEventPublisher;
  private readonly onPublishError?: (err: unknown) => void;

  constructor(deps: TicketsServiceDeps) {
    this.repository = deps.repository;
    /* The read model is its own order port by default: the same repository
       owns the projection, so no other module's internals are imported. */
    this.orders = deps.orders ?? deps.repository;
    this.release = deps.release;
    this.events = deps.events;
    this.onPublishError = deps.onPublishError;
  }

  /* E10 — active kitchen board. `status IN (live)` rather than `<> 'served'`:
     a denied round is closed too and must not wait for a cook who refused it. */
  async listTickets(params: TicketListParams): Promise<TicketPage> {
    const total = await this.repository.count(params.status);
    const rows = await this.repository.list(
      params.status,
      params.limit,
      (params.page - 1) * params.limit,
    );

    return {
      data: rows.map(toTicket),
      meta: buildMeta(params.page, params.limit, total),
    };
  }

  /* Ticket identification. A ticket is only observable through its own id;
     the parent order is part of the answer, never a replacement for it. */
  async getTicket(ticketId: string): Promise<TicketDetail> {
    const row = await this.repository.find(ticketId);
    if (!row) throw notFound();
    return { ...toTicket(row), denial_reason: row.denial_reason ?? "" };
  }

  /* E11 — one-tap advance. The conditional UPDATE is the concurrency guard:
     two taps race and exactly one moves the ticket; the loser is told which
     state it actually found. */
  async advanceTicket(
    ticketId: string,
    target: TicketAdvanceTarget,
  ): Promise<TicketAdvanceResult> {
    const from = NEXT_STATUS[target];

    /* Resolve the association first so an unknown ticket is a clean 404 and
       a foreign/absent order can never be advanced by id alone. */
    if (!(await this.orders.findOrder(ticketId))) throw notFound();

    const updated = await this.repository.advance(ticketId, from, target);
    if (updated) {
      this.publish(() =>
        this.events?.ticketAdvanced({
          ticketId: updated.id,
          orderId: updated.id,
          status: updated.status,
        }),
      );
      return { ticket_id: updated.id, order_id: updated.id, status: updated.status };
    }

    const current = await this.orders.findOrder(ticketId);
    if (!current) throw notFound();

    throw new AppError(
      409,
      "INVALID_STATUS_TRANSITION",
      `Ticket cannot move from ${current.status} to ${target}.`,
      { current_status: current.status, requested_status: target },
    );
  }

  /* E12 — serve. Only a READY ticket may be pruned; the status write and the
     waiter-ping clear share one transaction. The release engine runs after the
     commit in its own transaction (it locks the table), so a seating that is
     still occupied is simply not released. */
  async pruneTicket(ticketId: string): Promise<TicketServeResult> {
    const tableId = await this.repository.transaction(async (tx) => {
      const ticket = await tx.lockTicket(ticketId);
      if (!ticket) throw notFound();
      if (ticket.status !== "ready") {
        throw new AppError(
          409,
          "INVALID_STATUS_TRANSITION",
          `Ticket cannot be pruned from ${ticket.status}; only Ready tickets can be served.`,
          { current_status: ticket.status, requested_status: "served" },
        );
      }

      await tx.markServed(ticketId);
      await tx.clearWaiterPing(ticket.table_id);
      return ticket.table_id;
    });

    const tableCleared = await this.evaluateRelease(tableId);
    this.publish(() =>
      this.events?.ticketServed({ ticketId, orderId: ticketId, tableId }),
    );

    return {
      ticket_id: ticketId,
      order_id: ticketId,
      status: "served",
      table_cleared: tableCleared,
    };
  }

  /* PATCH /kds/tickets/:order_id/deny — valid from every live status: a dish
     can run out before it is started or after it is plated. The ticket stays
     in history with its reason, but leaves the board and frees the table to
     fire a replacement round. */
  async denyTicket(ticketId: string, reason: string): Promise<TicketDenyResult> {
    const denialReason = reason.trim();
    if (!denialReason) {
      throw new AppError(400, "VALIDATION_ERROR", "Request payload failed validation.", {
        fields: { reason: "Tell the diner why the order was refused." },
      });
    }

    const tableId = await this.repository.transaction(async (tx) => {
      const ticket = await tx.lockTicket(ticketId);
      if (!ticket) throw notFound();
      if (!LIVE_STATUSES.includes(ticket.status)) {
        throw new AppError(
          409,
          "INVALID_STATUS_TRANSITION",
          `Ticket cannot be denied from ${ticket.status}.`,
          { current_status: ticket.status, requested_status: "denied" },
        );
      }

      await tx.markDenied(ticketId, denialReason);
      await tx.clearWaiterPing(ticket.table_id);
      return ticket.table_id;
    });

    const tableCleared = await this.evaluateRelease(tableId);
    this.publish(() =>
      this.events?.ticketDenied({
        ticketId,
        orderId: ticketId,
        reason: denialReason,
      }),
    );

    return {
      ticket_id: ticketId,
      order_id: ticketId,
      status: "denied",
      denial_reason: denialReason,
      table_cleared: tableCleared,
    };
  }

  /* A release-engine failure must not turn a committed serve/deny into an
     HTTP error: the kitchen already did its part. The seating simply stays
     occupied and the periodic sweeper will re-evaluate it. */
  private async evaluateRelease(tableId: string): Promise<boolean> {
    if (!this.release) return false;
    try {
      const result = await this.release.checkAndAutoReleaseTable(tableId);
      return result.released === true;
    } catch (err) {
      this.onPublishError?.(err);
      return false;
    }
  }

  /** Events describe a committed change; a listener failure never fails it. */
  private publish(work: () => void): void {
    try {
      work();
    } catch (err) {
      this.onPublishError?.(err);
    }
  }
}

export type { ActiveTicketStatus };
