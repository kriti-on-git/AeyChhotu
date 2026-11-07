/* Kitchen module — orchestration rules.

   The service never moves a ticket itself. Acceptance, preparation and
   completion are commands on the Ticket port, whose conditional updates are
   the single authority for legal transitions and duplicate taps. What Kitchen
   adds is the kitchen-facing consequence of a committed move: a realtime
   nudge to the kitchen room and, for intake/completion, an internal fact.

   PUBLICATION IS BEST-EFFORT. A socket that is down or a listener that throws
   must never turn a committed kitchen action into an HTTP failure. The board
   refetches from the truth; the poll is the safety net. */

import {
  KITCHEN_EVENTS,
  KITCHEN_REALTIME_EVENTS,
  NOOP_KITCHEN_EVENTS,
} from "./kitchen.events.js";
import type {
  KitchenAdvanceResult,
  KitchenAdvanceTarget,
  KitchenBoard,
  KitchenBoardParams,
  KitchenDenyResult,
  KitchenEventPublisher,
  KitchenIncomingTicket,
  KitchenOrderPort,
  KitchenQueueSummary,
  KitchenRealtimePayload,
  KitchenRealtimePort,
  KitchenRepositoryPort,
  KitchenServeResult,
  KitchenServicePort,
  KitchenTicketPort,
  ShiftActivation,
  TicketStatus,
} from "./kitchen.types.js";

export interface KitchenServiceDeps {
  readonly tickets: KitchenTicketPort;
  readonly repository: KitchenRepositoryPort;
  /** Optional: without it notifications carry `table_id: null`. */
  readonly orders?: KitchenOrderPort;
  readonly realtime?: KitchenRealtimePort;
  readonly events?: KitchenEventPublisher;
  readonly assistantKey?: string | null;
  readonly onPublishError?: (err: unknown) => void;
}

const ARMED_DEVICE_LIMIT = 100;

export class KitchenService implements KitchenServicePort {
  private readonly tickets: KitchenTicketPort;
  private readonly repository: KitchenRepositoryPort;
  private readonly orders?: KitchenOrderPort;
  private readonly realtime?: KitchenRealtimePort;
  private readonly events: KitchenEventPublisher;
  private readonly key: string | null;
  private readonly onPublishError?: (err: unknown) => void;

  /** Process-local, exactly like the pre-module registry: a restart or a
      tablet reconnect re-arms. No table is touched. */
  private readonly armedDevices = new Map<string, number>();

  constructor(deps: KitchenServiceDeps) {
    this.tickets = deps.tickets;
    this.repository = deps.repository;
    this.orders = deps.orders;
    this.realtime = deps.realtime;
    this.events = deps.events ?? NOOP_KITCHEN_EVENTS;
    this.key = deps.assistantKey ?? null;
    this.onPublishError = deps.onPublishError;
  }

  /* -------------------------------------------------------------- board */

  getBoard(params: KitchenBoardParams): Promise<KitchenBoard> {
    return this.tickets.listTickets(params);
  }

  queue(): Promise<KitchenQueueSummary> {
    return this.repository.summary();
  }

  /* ----------------------------------------------------------- commands */

  async acceptTicket(ticketId: string): Promise<KitchenAdvanceResult> {
    const result = await this.tickets.advanceTicket(ticketId, "preparing");
    await this.announce(KITCHEN_REALTIME_EVENTS.accepted, result, "preparing");
    return result;
  }

  async markTicketReady(ticketId: string): Promise<KitchenAdvanceResult> {
    const result = await this.tickets.advanceTicket(ticketId, "ready");
    await this.announce(KITCHEN_REALTIME_EVENTS.ready, result, "ready");
    return result;
  }

  async completeTicket(ticketId: string): Promise<KitchenServeResult> {
    const result = await this.tickets.pruneTicket(ticketId);
    await this.announce(KITCHEN_REALTIME_EVENTS.served, result, "served");
    this.publish(() =>
      this.events.ticketCompleted({ ticketId: result.ticket_id, orderId: result.order_id }),
    );
    return result;
  }

  async denyTicket(ticketId: string, reason: string): Promise<KitchenDenyResult> {
    const result = await this.tickets.denyTicket(ticketId, reason);
    await this.announce(KITCHEN_REALTIME_EVENTS.denied, result, "denied");
    return result;
  }

  /* ------------------------------------------------------------- intake */

  /* Called by the composition root when Orders publishes `ticket.created`.
     The event is post-commit, so the association should exist; if it does not
     (a stale/replayed event), nothing is announced rather than inventing a
     table. A lookup failure is reported but still leaves the event's own
     table id usable. */
  async handleIncomingTicket(event: KitchenIncomingTicket): Promise<void> {
    let tableId = event.tableId;

    if (this.orders) {
      try {
        const order = await this.orders.findOrder(event.orderId);
        if (!order) return;
        tableId = order.table_id;
      } catch (err) {
        this.onPublishError?.(err);
      }
    }

    this.publishRealtime(KITCHEN_REALTIME_EVENTS.incoming, {
      ticket_id: event.ticketId,
      order_id: event.orderId,
      table_id: tableId,
      status: "pending",
    });
    this.publish(() =>
      this.events.ticketIncoming({
        ticketId: event.ticketId,
        orderId: event.orderId,
        tableId,
      }),
    );
  }

  /* --------------------------------------------------------------- shift */

  activateShift(deviceId: string): ShiftActivation {
    this.armedDevices.set(deviceId, Date.now());

    // Keep the registry bounded if tablets re-register with fresh ids.
    if (this.armedDevices.size > ARMED_DEVICE_LIMIT) {
      const oldest = [...this.armedDevices.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) this.armedDevices.delete(oldest[0]);
    }

    return {
      device_id: deviceId,
      audio_armed: true,
      message: "Audio chimes armed for this device. Incoming tickets will ping.",
    };
  }

  assistantKey(): string | null {
    return this.key;
  }

  /* --------------------------------------------------------- publication */

  /** Announces a committed move after resolving its table association. */
  private async announce(
    event: string,
    result: { ticket_id: string; order_id: string },
    status: TicketStatus,
  ): Promise<void> {
    const tableId = await this.tableIdFor(result.order_id);
    this.publishRealtime(event, {
      ticket_id: result.ticket_id,
      order_id: result.order_id,
      table_id: tableId,
      status,
    });
  }

  private async tableIdFor(orderId: string): Promise<string | null> {
    if (!this.orders) return null;
    try {
      const order = await this.orders.findOrder(orderId);
      return order?.table_id ?? null;
    } catch (err) {
      this.onPublishError?.(err);
      return null;
    }
  }

  private publishRealtime(event: string, payload: KitchenRealtimePayload): void {
    if (!this.realtime) return;
    try {
      this.realtime.toKitchen(event, payload);
    } catch (err) {
      this.onPublishError?.(err);
    }
  }

  /** Events describe committed work; a listener failure never fails it. */
  private publish(work: () => void): void {
    try {
      work();
    } catch (err) {
      this.onPublishError?.(err);
    }
  }
}

export type { KitchenAdvanceTarget, KitchenAdvanceResult, KITCHEN_EVENTS };
